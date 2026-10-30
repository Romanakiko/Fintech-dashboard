//! PCG32 (XSH-RR) pseudo-random number generator.
//!
//! M. E. O'Neill, "PCG: A Family of Simple Fast Space-Efficient Statistically
//! Good Algorithms for Random Number Generation" (2014). Hand-written and
//! dependency-free, so all randomness runs inside the Wasm module and a given
//! seed always reproduces the same market stream.

const MULTIPLIER: u64 = 6_364_136_223_846_793_005;

#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    /// Seeds the generator; `stream` selects one of 2^63 independent sequences.
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut rng = Self {
            state: 0,
            inc: (stream << 1) | 1,
        };
        rng.next_u32();
        rng.state = rng.state.wrapping_add(seed);
        rng.next_u32();
        rng
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(MULTIPLIER).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform integer in `0..bound` without modulo bias. `bound` must be non-zero.
    pub fn below(&mut self, bound: u32) -> u32 {
        debug_assert!(bound > 0);
        let threshold = bound.wrapping_neg() % bound;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % bound;
            }
        }
    }

    /// Uniform integer in `lo..=hi`.
    pub fn between(&mut self, lo: i64, hi: i64) -> i64 {
        debug_assert!(lo <= hi && hi - lo < i64::from(u32::MAX));
        lo + i64::from(self.below((hi - lo + 1) as u32))
    }

    pub fn coin(&mut self) -> bool {
        self.next_u32() >> 31 == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_reference_implementation() {
        // Output of the reference pcg32-demo: pcg32_srandom_r(&rng, 42, 54).
        let mut rng = Pcg32::new(42, 54);
        let expected = [
            0xa15c_02b7,
            0x7b47_f409,
            0xba1d_3330,
            0x83d2_f293,
            0xbfa4_784b,
            0xcbed_606e,
        ];
        for value in expected {
            assert_eq!(rng.next_u32(), value);
        }
    }

    #[test]
    fn below_stays_within_bound() {
        let mut rng = Pcg32::new(7, 1);
        assert!((0..10_000).all(|_| rng.below(1) == 0));
        assert!((0..10_000).all(|_| rng.below(13) < 13));
    }

    #[test]
    fn between_is_inclusive_on_both_ends() {
        let mut rng = Pcg32::new(7, 1);
        let values: Vec<i64> = (0..10_000).map(|_| rng.between(-3, 3)).collect();
        assert!(values.iter().all(|v| (-3..=3).contains(v)));
        assert!(values.contains(&-3));
        assert!(values.contains(&3));
    }

    #[test]
    fn coin_is_roughly_fair() {
        let mut rng = Pcg32::new(7, 1);
        let heads = (0..10_000).filter(|_| rng.coin()).count();
        assert!((4_500..=5_500).contains(&heads), "heads = {heads}");
    }
}
