//! The pure computation behind requests: no I/O, no clock, no allocator
//! surprises. Timing belongs to the caller — `Instant` on the server,
//! `performance.now()` in the browser — because neither exists on the other
//! side.

/// `fib` is a CPU burner, not a maths library. Keep it inside u128.
pub const MAX_FIB: u32 = 185;

/// Iterative Fibonacci as a decimal string: fib(185) overflows u64, and
/// JavaScript numbers, well before that.
pub fn fib(n: u32) -> Result<String, String> {
    if n > MAX_FIB {
        return Err(format!("n must be {MAX_FIB} or less"));
    }

    let (mut a, mut b) = (0u128, 1u128);
    for _ in 0..n {
        (a, b) = (b, a + b);
    }

    Ok(a.to_string())
}

/// Reverses by character, not by byte, so multibyte text survives.
pub fn reverse(text: &str) -> String {
    text.chars().rev().collect()
}

/// Bytes the way people write them: `1536` -> `1.5 KiB`.
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut value = bytes as f64;
    let mut unit = 0;

    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fib_of_the_small_cases_everyone_knows() {
        assert_eq!(fib(0).unwrap(), "0");
        assert_eq!(fib(1).unwrap(), "1");
        assert_eq!(fib(10).unwrap(), "55");
    }

    #[test]
    fn fib_at_the_ceiling_still_fits_u128() {
        // Independently checkable: fib(185).
        assert_eq!(fib(185).unwrap(), "205697230343233228174223751303346572685");
    }

    #[test]
    fn fib_past_the_ceiling_refuses() {
        assert_eq!(fib(186), Err("n must be 185 or less".into()));
    }

    #[test]
    fn reverse_counts_characters_not_bytes() {
        assert_eq!(reverse("hello"), "olleh");
        assert_eq!(reverse("日本語"), "語本日");
    }

    #[test]
    fn bytes_read_the_way_people_write_them() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(512), "512 B");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(1536), "1.5 KiB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MiB");
    }
}
