//! Length-prefixed JSON framing.
//!
//! A QUIC stream is a byte pipe, not a message pipe: one `read` can return half
//! a message or three of them. Every frame is therefore a 4-byte big-endian
//! length followed by that many bytes of JSON. The TypeScript client uses the
//! identical layout.

use anyhow::bail;
use anyhow::Result;
use serde::de::DeserializeOwned;
use serde::Serialize;
use wtransport::RecvStream;
use wtransport::SendStream;

/// Refuse anything larger than this so a bad length prefix can't allocate the heap away.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Serializes `message` and writes it as one frame.
pub async fn write_frame<T: Serialize>(stream: &mut SendStream, message: &T) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    if body.len() > MAX_FRAME_BYTES {
        bail!("outgoing frame is {} bytes", body.len());
    }

    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);

    stream.write_all(&frame).await?;
    Ok(())
}

/// Reads one frame. Returns `Ok(None)` when the peer finished the stream cleanly
/// on a frame boundary, which is the normal end of a conversation.
pub async fn read_frame<T: DeserializeOwned>(stream: &mut RecvStream) -> Result<Option<T>> {
    let mut length = [0u8; 4];
    if !read_exact(stream, &mut length).await? {
        return Ok(None);
    }

    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        bail!("peer announced a {length} byte frame");
    }

    let mut body = vec![0u8; length];
    if !read_exact(stream, &mut body).await? {
        bail!("stream ended {length} bytes into a frame body");
    }

    Ok(Some(serde_json::from_slice(&body)?))
}

/// Fills `buf` completely. Returns `Ok(false)` for a clean end of stream before
/// any byte was read, `Err` if the stream ended partway through.
async fn read_exact(stream: &mut RecvStream, buf: &mut [u8]) -> Result<bool> {
    let mut filled = 0;

    while filled < buf.len() {
        match stream.read(&mut buf[filled..]).await? {
            Some(0) => continue,
            Some(n) => filled += n,
            None if filled == 0 => return Ok(false),
            None => bail!("stream ended after {filled} of {} bytes", buf.len()),
        }
    }

    Ok(true)
}
