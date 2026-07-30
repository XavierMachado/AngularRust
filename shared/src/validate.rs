//! The rules a message must pass before it is broadcast.
//!
//! One implementation, both enforcement points: the server applies these in
//! `answer`, and the browser applies the identical code through wasm before
//! sending — so what the client refuses is exactly what the server would
//! refuse, and the limits cannot drift apart.

/// Longest author name that will be broadcast.
pub const MAX_AUTHOR_CHARS: usize = 24;

/// Longest message text that will be broadcast.
pub const MAX_TEXT_CHARS: usize = 280;

/// A `Say` that passed validation, trimmed and ready to broadcast.
#[derive(Debug, PartialEq, Eq)]
pub struct SayMessage {
    pub author: String,
    pub text: String,
}

/// Trims, bounds, and defaults a `Say` request the one canonical way.
pub fn validate_say(author: &str, text: &str) -> Result<SayMessage, String> {
    let author = trim_to(author.trim(), MAX_AUTHOR_CHARS);
    let text = trim_to(text.trim(), MAX_TEXT_CHARS);

    if text.is_empty() {
        return Err("message is empty".into());
    }

    Ok(SayMessage {
        author: if author.is_empty() {
            "anonymous".into()
        } else {
            author
        },
        text,
    })
}

/// Truncates to `limit` characters — characters, not bytes, so multibyte text
/// is cut between characters rather than through one.
pub fn trim_to(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trimming_counts_characters_not_bytes() {
        assert_eq!(trim_to("hello", 10), "hello");
        assert_eq!(trim_to("hello", 3), "hel");
        // Four characters, twelve bytes: a byte-wise truncation would split one.
        assert_eq!(trim_to("日本語です", 4), "日本語で");
    }

    #[test]
    fn an_empty_message_is_refused() {
        assert_eq!(validate_say("ash", "   "), Err("message is empty".into()));
    }

    #[test]
    fn a_blank_author_becomes_anonymous() {
        let said = validate_say("  ", "hello").unwrap();
        assert_eq!(said.author, "anonymous");
        assert_eq!(said.text, "hello");
    }

    #[test]
    fn long_input_is_cut_at_the_limits() {
        let author = "a".repeat(MAX_AUTHOR_CHARS + 10);
        let text = "t".repeat(MAX_TEXT_CHARS + 10);

        let said = validate_say(&author, &text).unwrap();
        assert_eq!(said.author.chars().count(), MAX_AUTHOR_CHARS);
        assert_eq!(said.text.chars().count(), MAX_TEXT_CHARS);
    }
}
