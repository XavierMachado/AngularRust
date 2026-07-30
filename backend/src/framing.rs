//! The QUIC-stream side of the shared framing codec.
//!
//! `wt_shared::framing` owns the frame format — the 4-byte big-endian length,
//! the size cap, the chunk-boundary bookkeeping — and the browser runs that
//! same code through wasm. This module is only the part that cannot be shared:
//! moving bytes between the codec and a `wtransport` stream, and JSON on the
//! way through.

use anyhow::bail;
use anyhow::Result;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::VecDeque;
use wt_shared::framing::encode_frame;
use wt_shared::framing::FrameDecoder;
use wtransport::RecvStream;
use wtransport::SendStream;

/// Serializes `message` and writes it as one frame.
pub async fn write_frame<T: Serialize>(stream: &mut SendStream, message: &T) -> Result<()> {
    let body = serde_json::to_vec(message)?;
    let frame = encode_frame(&body)?;
    stream.write_all(&frame).await?;
    Ok(())
}

/// Pulls whole messages off one receive stream.
///
/// Reads arrive as arbitrary chunks; the shared decoder buffers them and hands
/// back complete bodies, which this type queues and deserializes one `next()`
/// at a time.
pub struct FrameReader {
    stream: RecvStream,
    decoder: FrameDecoder,
    ready: VecDeque<Vec<u8>>,
}

impl FrameReader {
    pub fn new(stream: RecvStream) -> Self {
        Self {
            stream,
            decoder: FrameDecoder::new(),
            ready: VecDeque::new(),
        }
    }

    /// Reads one message. Returns `Ok(None)` when the peer finished the stream
    /// cleanly on a frame boundary, which is the normal end of a conversation.
    pub async fn next<T: DeserializeOwned>(&mut self) -> Result<Option<T>> {
        loop {
            if let Some(body) = self.ready.pop_front() {
                return Ok(Some(serde_json::from_slice(&body)?));
            }

            let mut buffer = [0u8; 4096];
            match self.stream.read(&mut buffer).await? {
                Some(0) => continue,
                Some(read) => self.ready.extend(self.decoder.push(&buffer[..read])?),
                None if self.decoder.has_partial_frame() => bail!("stream ended mid-frame"),
                None => return Ok(None),
            }
        }
    }
}
