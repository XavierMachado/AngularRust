//! The browser's door into `wt-shared`.
//!
//! Every function here is a thin cast around the shared crate: bytes cross the
//! boundary as `Uint8Array`, JSON crosses as strings and is parsed by the
//! engine's own `JSON.parse`, which is faster than marshalling structured
//! values through the boundary. Nothing in this crate has logic worth testing —
//! the tests live in `wt-shared`, and the client's vitest suite runs against
//! the compiled wasm through `client/src/app/core/framing.ts`.

use wasm_bindgen::prelude::*;

/// Wraps one JSON-encoded message in a length-prefixed frame.
#[wasm_bindgen]
pub fn encode_frame(json: &str) -> Result<Vec<u8>, JsError> {
    wt_shared::framing::encode_frame(json.as_bytes()).map_err(into_js_error)
}

/// The shared chunk-boundary decoder, holding buffered bytes between pushes.
#[wasm_bindgen]
pub struct WasmFrameDecoder {
    inner: wt_shared::framing::FrameDecoder,
}

#[wasm_bindgen]
impl WasmFrameDecoder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: wt_shared::framing::FrameDecoder::new(),
        }
    }

    /// Feeds one chunk in, gets zero or more complete frame bodies out, each
    /// as a JSON string for the caller to `JSON.parse`.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, JsError> {
        let bodies = self.inner.push(chunk).map_err(into_js_error)?;

        bodies
            .into_iter()
            .map(|body| String::from_utf8(body).map_err(|error| JsError::new(&error.to_string())))
            .collect()
    }

    /// True when a partial frame is still buffered.
    #[wasm_bindgen(getter)]
    pub fn has_partial_frame(&self) -> bool {
        self.inner.has_partial_frame()
    }
}

impl Default for WasmFrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// Prefixes a message with its lane and stream id, for transports that carry
/// every lane on one channel. See `wt_shared::lane`.
///
/// `stream` is an f64 because that is what a JavaScript number is. Upload ids
/// are small counters, so the 2^53 an f64 holds exactly is not a limit anyone
/// will reach.
#[wasm_bindgen]
pub fn encode_lane(lane: u8, stream: f64, body: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(wt_shared::lane::encode_lane(
        lane_from_tag(lane)?,
        stream as u64,
        body,
    ))
}

/// One decoded lane message. The body stays bytes: the caller knows from the
/// lane whether to decode it as text or count it as bulk.
#[wasm_bindgen]
pub struct DecodedLane {
    lane: u8,
    stream: f64,
    body: Vec<u8>,
}

#[wasm_bindgen]
impl DecodedLane {
    #[wasm_bindgen(getter)]
    pub fn lane(&self) -> u8 {
        self.lane
    }

    #[wasm_bindgen(getter)]
    pub fn stream(&self) -> f64 {
        self.stream
    }

    #[wasm_bindgen(getter)]
    pub fn body(&self) -> Vec<u8> {
        self.body.clone()
    }
}

/// Splits one received message into its lane, stream id and body, throwing on
/// a short header, an unknown lane, or an oversized JSON body.
#[wasm_bindgen]
pub fn decode_lane(message: &[u8]) -> Result<DecodedLane, JsError> {
    let decoded =
        wt_shared::lane::decode_lane(message).map_err(|error| JsError::new(&error.to_string()))?;

    Ok(DecodedLane {
        lane: decoded.lane as u8,
        stream: decoded.stream as f64,
        body: decoded.body.to_vec(),
    })
}

fn lane_from_tag(tag: u8) -> Result<wt_shared::lane::Lane, JsError> {
    use wt_shared::lane::Lane;

    match tag {
        1 => Ok(Lane::Control),
        2 => Ok(Lane::Datagram),
        3 => Ok(Lane::Upload),
        4 => Ok(Lane::UploadEnd),
        other => Err(JsError::new(&format!("unknown lane tag {other}"))),
    }
}

/// Fibonacci as a decimal string — the same `wt_shared::compute::fib` the
/// server runs, so the browser and the server cannot disagree.
#[wasm_bindgen]
pub fn fib(n: u32) -> Result<String, JsError> {
    wt_shared::compute::fib(n).map_err(|message| JsError::new(&message))
}

/// Reverses by character, exactly as the server would.
#[wasm_bindgen]
pub fn reverse(text: &str) -> String {
    wt_shared::compute::reverse(text)
}

/// Bytes the way people write them. Takes an f64 because that is what a
/// JavaScript number is; the shared implementation wants a u64.
#[wasm_bindgen]
pub fn human_bytes(bytes: f64) -> String {
    wt_shared::compute::human_bytes(bytes as u64)
}

/// Applies the server's own `Say` rules. Returns the trimmed
/// `{"author":...,"text":...}` as JSON, or throws the exact message the
/// server would reply with.
#[wasm_bindgen]
pub fn validate_say(author: &str, text: &str) -> Result<String, JsError> {
    let said = wt_shared::validate::validate_say(author, text)
        .map_err(|message| JsError::new(&message))?;

    serde_json::to_string(&serde_json::json!({
        "author": said.author,
        "text": said.text,
    }))
    .map_err(|error| JsError::new(&error.to_string()))
}

fn into_js_error(error: wt_shared::framing::FrameError) -> JsError {
    JsError::new(&error.to_string())
}
