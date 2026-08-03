//! The thinnest possible wrapper: the whole startup lives in
//! `wt_server::boot` so that `tests/` and the desktop shell in `desktop/` can
//! run the same server this binary does.

use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    wt_server::boot::run().await
}
