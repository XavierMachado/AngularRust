//! Length-prefixed framing: 4-byte big-endian length, then that many bytes.
//!
//! A QUIC stream is a byte pipe, not a message pipe: one read can return half
//! a message or three of them. This module owns the frame *format* and the
//! chunk-boundary bookkeeping; what the bytes mean (JSON, here) and where they
//! come from (a QUIC stream, a test vector) are the caller's business. That
//! split is what lets the identical code run in the server and, through wasm,
//! in the browser.

use std::fmt;

/// Refuse anything larger than this so a bad length prefix can't allocate the
/// heap away.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Length prefix size.
pub const HEADER_BYTES: usize = 4;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// An outgoing body exceeds [`MAX_FRAME_BYTES`].
    BodyTooLarge(usize),
    /// An incoming length prefix announces more than [`MAX_FRAME_BYTES`].
    AnnouncedTooLarge(usize),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BodyTooLarge(size) => write!(f, "outgoing frame is {size} bytes"),
            Self::AnnouncedTooLarge(size) => write!(f, "peer announced a {size} byte frame"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Wraps one body in a frame.
pub fn encode_frame(body: &[u8]) -> Result<Vec<u8>, FrameError> {
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::BodyTooLarge(body.len()));
    }

    let mut frame = Vec::with_capacity(HEADER_BYTES + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    Ok(frame)
}

/// Accumulates stream chunks and emits complete frame bodies.
///
/// Push-based on purpose: both a browser `ReadableStream` and a QUIC receive
/// stream hand over arbitrary chunks, so the decoder buffers across calls and
/// only surfaces whole bodies.
#[derive(Default)]
pub struct FrameDecoder {
    pending: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one chunk in, gets zero or more complete frame bodies out.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, FrameError> {
        self.pending.extend_from_slice(chunk);

        let mut bodies = Vec::new();

        loop {
            if self.pending.len() < HEADER_BYTES {
                break;
            }

            let length =
                u32::from_be_bytes(self.pending[..HEADER_BYTES].try_into().expect("4 bytes"))
                    as usize;

            if length > MAX_FRAME_BYTES {
                return Err(FrameError::AnnouncedTooLarge(length));
            }

            if self.pending.len() < HEADER_BYTES + length {
                break;
            }

            bodies.push(self.pending[HEADER_BYTES..HEADER_BYTES + length].to_vec());
            self.pending.drain(..HEADER_BYTES + length);
        }

        Ok(bodies)
    }

    /// True when a partial frame is still buffered. A stream that ends here
    /// ended mid-frame, which is an error worth reporting, not a clean close.
    pub fn has_partial_frame(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same awkward shapes client/src/app/core/framing.spec.ts feeds the
    // TypeScript decoder: a frame arriving one byte at a time, several frames
    // in one chunk, and a boundary inside the length prefix.

    fn frame(body: &[u8]) -> Vec<u8> {
        encode_frame(body).expect("test body fits")
    }

    #[test]
    fn prefixes_the_body_with_its_length_big_endian() {
        let encoded = frame(b"{\"op\":\"ping\"}");
        assert_eq!(encoded[..4], 13u32.to_be_bytes());
        assert_eq!(&encoded[4..], b"{\"op\":\"ping\"}");
    }

    #[test]
    fn round_trips_through_the_decoder() {
        let mut decoder = FrameDecoder::new();
        let bodies = decoder.push(&frame(b"the quick brown fox")).unwrap();
        assert_eq!(bodies, vec![b"the quick brown fox".to_vec()]);
        assert!(!decoder.has_partial_frame());
    }

    #[test]
    fn waits_for_a_frame_that_arrives_one_byte_at_a_time() {
        let mut decoder = FrameDecoder::new();
        let encoded = frame(b"slow");

        for byte in &encoded[..encoded.len() - 1] {
            assert!(decoder.push(&[*byte]).unwrap().is_empty());
        }

        assert!(decoder.has_partial_frame());
        let bodies = decoder.push(&encoded[encoded.len() - 1..]).unwrap();
        assert_eq!(bodies, vec![b"slow".to_vec()]);
        assert!(!decoder.has_partial_frame());
    }

    #[test]
    fn emits_every_frame_in_a_chunk_that_holds_several() {
        let mut merged = Vec::new();
        merged.extend(frame(b"one"));
        merged.extend(frame(b"two"));
        merged.extend(frame(b"three"));

        let bodies = FrameDecoder::new().push(&merged).unwrap();
        assert_eq!(
            bodies,
            vec![b"one".to_vec(), b"two".to_vec(), b"three".to_vec()]
        );
    }

    #[test]
    fn handles_a_chunk_boundary_inside_the_length_prefix() {
        let mut decoder = FrameDecoder::new();
        let encoded = frame(b"split");

        assert!(decoder.push(&encoded[..2]).unwrap().is_empty());
        assert_eq!(
            decoder.push(&encoded[2..]).unwrap(),
            vec![b"split".to_vec()]
        );
    }

    #[test]
    fn keeps_the_tail_of_a_chunk_that_ends_mid_frame() {
        let mut decoder = FrameDecoder::new();
        let first = frame(b"first");
        let second = frame(b"second");

        let mut chunk = first.clone();
        chunk.extend(&second[..3]);

        assert_eq!(decoder.push(&chunk).unwrap(), vec![b"first".to_vec()]);
        assert_eq!(
            decoder.push(&second[3..]).unwrap(),
            vec![b"second".to_vec()]
        );
    }

    #[test]
    fn refuses_an_implausible_length_prefix_instead_of_allocating_for_it() {
        let mut decoder = FrameDecoder::new();
        let mut hostile = vec![0u8; 8];
        hostile[..4].copy_from_slice(&u32::MAX.to_be_bytes());

        assert_eq!(
            decoder.push(&hostile),
            Err(FrameError::AnnouncedTooLarge(u32::MAX as usize))
        );
    }

    #[test]
    fn refuses_an_oversized_outgoing_body() {
        let body = vec![0u8; MAX_FRAME_BYTES + 1];
        assert_eq!(
            encode_frame(&body),
            Err(FrameError::BodyTooLarge(MAX_FRAME_BYTES + 1))
        );
    }
}
