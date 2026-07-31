//! Lane multiplexing, for transports that have only one channel.
//!
//! WebTransport gives every logical lane a channel of its own, so nothing here
//! is needed: a bidirectional stream *is* the call, a datagram *is* the
//! datagram. A WebSocket gives you one ordered reliable duplex channel and
//! nothing else, so the four lanes have to share it and each message has to say
//! which one it belongs to.
//!
//! ## Why not the length prefix from [`crate::framing`]
//!
//! That codec exists because a QUIC stream is a byte pipe: one read can hand
//! you half a message or three of them, so the length has to be on the wire.
//! WebSocket messages are already delimited — one `send` is one `recv` — so
//! re-framing them would be pure overhead. What is missing is not the boundary
//! but the *label*, and that is all this module adds.
//!
//! ## The header
//!
//! ```text
//! byte 0      lane tag
//! bytes 1..9  stream id, u64 big-endian
//! bytes 9..   body
//! ```
//!
//! Nine bytes on every message, and upload bytes stay raw — the alternative,
//! wrapping them in JSON, would base64 a megabyte upload into 1.4 MB of text.
//! The stream id is what lets concurrent uploads interleave; the control and
//! datagram lanes leave it zero.

/// Which lane a message belongs to.
///
/// The discriminants are the wire values and must not be renumbered: a client
/// and a server that disagree would mis-route every message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Lane {
    /// One JSON `ClientFrame` or `ServerFrame`.
    Control = 1,
    /// One JSON `DatagramIn` or `DatagramOut`.
    ///
    /// Reliable and ordered here, unlike its WebTransport counterpart. The name
    /// describes the role, not the guarantee, and the console labels it as
    /// emulated so nobody reads a perfect delivery rate as a real one.
    Datagram = 2,
    /// Raw upload bytes belonging to the message's stream id.
    Upload = 3,
    /// End of the upload with the message's stream id. Empty body.
    UploadEnd = 4,
}

impl Lane {
    fn from_tag(tag: u8) -> Option<Self> {
        match tag {
            1 => Some(Self::Control),
            2 => Some(Self::Datagram),
            3 => Some(Self::Upload),
            4 => Some(Self::UploadEnd),
            _ => None,
        }
    }
}

/// Lane tag plus stream id.
pub const HEADER_BYTES: usize = 1 + 8;

/// One decoded message, borrowing its body from the caller's buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaneMessage<'a> {
    pub lane: Lane,
    /// Which upload the body belongs to. Zero on the control and datagram lanes.
    pub stream: u64,
    pub body: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaneError {
    /// Fewer bytes than a header, so there is nothing to route.
    Short(usize),
    /// A lane tag this build does not know.
    UnknownLane(u8),
    /// A control or datagram body over [`crate::framing::MAX_FRAME_BYTES`].
    /// Upload bodies are bounded by the transport's message size limit instead.
    TooLarge(usize),
}

impl std::fmt::Display for LaneError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Short(size) => {
                write!(
                    formatter,
                    "lane message is {size} bytes, header needs {HEADER_BYTES}"
                )
            }
            Self::UnknownLane(tag) => write!(formatter, "unknown lane tag {tag}"),
            Self::TooLarge(size) => write!(formatter, "peer sent a {size} byte lane message"),
        }
    }
}

impl std::error::Error for LaneError {}

/// Prefixes `body` with its lane and stream id.
pub fn encode_lane(lane: Lane, stream: u64, body: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(HEADER_BYTES + body.len());
    message.push(lane as u8);
    message.extend_from_slice(&stream.to_be_bytes());
    message.extend_from_slice(body);
    message
}

/// Splits one received message into its lane, stream id and body.
pub fn decode_lane(message: &[u8]) -> Result<LaneMessage<'_>, LaneError> {
    if message.len() < HEADER_BYTES {
        return Err(LaneError::Short(message.len()));
    }

    let lane = Lane::from_tag(message[0]).ok_or(LaneError::UnknownLane(message[0]))?;

    // The slice is exactly 8 bytes, so the conversion cannot fail.
    let stream = u64::from_be_bytes(message[1..HEADER_BYTES].try_into().unwrap());
    let body = &message[HEADER_BYTES..];

    // The JSON lanes share the frame ceiling, so a peer cannot make us parse an
    // unbounded document. Upload bodies are capped by the transport instead:
    // they are counted, never buffered.
    if matches!(lane, Lane::Control | Lane::Datagram)
        && body.len() > crate::framing::MAX_FRAME_BYTES
    {
        return Err(LaneError::TooLarge(body.len()));
    }

    Ok(LaneMessage { lane, stream, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_is_a_tag_then_a_big_endian_stream_id() {
        let message = encode_lane(Lane::Upload, 0x0102_0304_0506_0708, b"xy");

        assert_eq!(
            message,
            vec![3, 1, 2, 3, 4, 5, 6, 7, 8, b'x', b'y'],
            "the tag comes first, then eight bytes most significant first"
        );
    }

    #[test]
    fn round_trip() {
        let message = encode_lane(Lane::Control, 0, br#"{"t":"call"}"#);
        let decoded = decode_lane(&message).expect("a message this size decodes");

        assert_eq!(decoded.lane, Lane::Control);
        assert_eq!(decoded.stream, 0);
        assert_eq!(decoded.body, br#"{"t":"call"}"#);
    }

    #[test]
    fn stream_ids_survive_the_round_trip() {
        for stream in [0, 1, 255, 256, u64::MAX] {
            let message = encode_lane(Lane::Upload, stream, &[]);
            assert_eq!(decode_lane(&message).unwrap().stream, stream);
        }
    }

    #[test]
    fn an_empty_body_is_fine() {
        // How the end of an upload is announced.
        let message = encode_lane(Lane::UploadEnd, 7, &[]);
        let decoded = decode_lane(&message).unwrap();

        assert_eq!(decoded.lane, Lane::UploadEnd);
        assert_eq!(decoded.stream, 7);
        assert!(decoded.body.is_empty());
    }

    #[test]
    fn a_truncated_header_is_refused() {
        // Eight bytes: one short, and reading the stream id would run off the end.
        assert_eq!(
            decode_lane(&[1, 0, 0, 0, 0, 0, 0, 0]),
            Err(LaneError::Short(8))
        );
        assert_eq!(decode_lane(&[]), Err(LaneError::Short(0)));
    }

    #[test]
    fn an_unknown_lane_is_refused_rather_than_guessed() {
        let mut message = encode_lane(Lane::Control, 0, b"{}");
        message[0] = 9;

        assert_eq!(decode_lane(&message), Err(LaneError::UnknownLane(9)));
    }

    #[test]
    fn an_oversized_json_body_is_refused() {
        let body = vec![b' '; crate::framing::MAX_FRAME_BYTES + 1];
        let message = encode_lane(Lane::Datagram, 0, &body);

        assert_eq!(decode_lane(&message), Err(LaneError::TooLarge(body.len())));
    }

    #[test]
    fn an_oversized_upload_body_is_allowed_through() {
        // Upload bytes are counted, not parsed, so the frame ceiling does not
        // apply to them; the transport's own message limit is the bound.
        let body = vec![0u8; crate::framing::MAX_FRAME_BYTES + 1];
        let message = encode_lane(Lane::Upload, 1, &body);

        assert_eq!(decode_lane(&message).unwrap().body.len(), body.len());
    }
}
