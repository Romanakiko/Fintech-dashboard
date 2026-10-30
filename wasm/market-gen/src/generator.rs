//! Stateful batch generator: owns the RNG, per-instrument state and the
//! output buffer.

use crate::model::{InstrumentState, MAX_BATCH, MAX_INSTRUMENTS, Update};
use crate::rng::Pcg32;

/// Fixed PCG stream; the seed alone selects the market sequence.
const STREAM: u64 = 0x5eed_f00d;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInstrumentCount,
    InvalidMaxBatch,
    InvalidBatchSize,
    NotInitialized,
}

impl Error {
    /// Stable negative codes returned across the Wasm ABI.
    pub const fn code(self) -> i32 {
        match self {
            Self::InvalidInstrumentCount => -1,
            Self::InvalidMaxBatch => -2,
            Self::InvalidBatchSize => -3,
            Self::NotInitialized => -4,
        }
    }
}

pub struct Generator {
    rng: Pcg32,
    instruments: Vec<InstrumentState>,
    out: Vec<Update>,
}

impl Generator {
    pub fn new(seed: u64, instrument_count: u32, max_batch: u32) -> Result<Self, Error> {
        if !(1..=MAX_INSTRUMENTS).contains(&instrument_count) {
            return Err(Error::InvalidInstrumentCount);
        }
        if !(1..=MAX_BATCH).contains(&max_batch) {
            return Err(Error::InvalidMaxBatch);
        }
        let mut rng = Pcg32::new(seed, STREAM);
        let instruments = (0..instrument_count)
            .map(|_| InstrumentState::random(&mut rng))
            .collect();
        Ok(Self {
            rng,
            instruments,
            out: Vec::with_capacity(max_batch as usize),
        })
    }

    /// Generates exactly `n` updates into the buffer allocated by [`Generator::new`].
    ///
    /// The buffer never grows, so its address stays stable for the lifetime of
    /// the generator and JS can keep a typed-array view over it.
    pub fn generate(&mut self, n: u32) -> Result<&[Update], Error> {
        let n = n as usize;
        if n == 0 || n > self.out.capacity() {
            return Err(Error::InvalidBatchSize);
        }
        self.out.clear();
        let count = self.instruments.len() as u32;
        for _ in 0..n {
            let index = self.rng.below(count);
            let update = self.instruments[index as usize].step(index, &mut self.rng);
            self.out.push(update);
        }
        Ok(&self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MAX_BOOK_QTY, MAX_TRADE_QTY};

    fn collect(seed: u64, instruments: u32, batches: &[u32]) -> Vec<Update> {
        let max = batches.iter().copied().max().unwrap_or(1);
        let mut generator = Generator::new(seed, instruments, max).unwrap();
        batches
            .iter()
            .flat_map(|&n| generator.generate(n).unwrap().to_vec())
            .collect()
    }

    #[test]
    fn returns_exactly_the_requested_batch_size() {
        let mut generator = Generator::new(1, 5, MAX_BATCH).unwrap();
        for n in [1, 7, 100, MAX_BATCH] {
            assert_eq!(generator.generate(n).unwrap().len(), n as usize);
        }
    }

    #[test]
    fn every_update_satisfies_market_invariants() {
        for seed in 0..20 {
            for update in collect(seed, 50, &[1_000; 100]) {
                assert!(update.instrument < 50);
                assert!(update.bid_cents > 0);
                assert!(update.bid_cents < update.ask_cents);
                assert!(
                    update.price_cents == update.bid_cents
                        || update.price_cents == update.ask_cents
                );
                assert!((1..=MAX_TRADE_QTY).contains(&update.trade_qty));
                assert!(i64::from(update.bid_qty) <= MAX_BOOK_QTY);
                assert!(i64::from(update.ask_qty) <= MAX_BOOK_QTY);
            }
        }
    }

    #[test]
    fn same_seed_reproduces_the_stream_and_other_seeds_differ() {
        assert_eq!(collect(42, 5, &[500; 4]), collect(42, 5, &[500; 4]));
        assert_ne!(collect(42, 5, &[500; 4]), collect(43, 5, &[500; 4]));
    }

    #[test]
    fn state_carries_over_between_calls() {
        // Five calls of 200 must continue the same sequence as one call of 1000.
        assert_eq!(collect(9, 10, &[200; 5]), collect(9, 10, &[1_000]));
    }

    #[test]
    fn prices_evolve_from_previous_values() {
        let updates = collect(5, 3, &[1_000; 50]);
        let mut last_bid: [Option<u32>; 3] = [None; 3];
        for update in updates {
            let slot = &mut last_bid[update.instrument as usize];
            if let Some(previous) = *slot {
                // A step is at most ~5 bps plus the mean-reversion pull, far below 2%.
                let limit = 1 + previous / 50;
                assert!(
                    update.bid_cents.abs_diff(previous) <= limit,
                    "bid jumped from {previous} to {}",
                    update.bid_cents
                );
            }
            *slot = Some(update.bid_cents);
        }
    }

    #[test]
    fn every_instrument_receives_updates() {
        let updates = collect(11, 50, &[1_000; 10]);
        for index in 0..50 {
            assert!(updates.iter().any(|u| u.instrument == index));
        }
    }

    #[test]
    fn rejects_invalid_configuration() {
        assert_eq!(
            Generator::new(1, 0, 10).err(),
            Some(Error::InvalidInstrumentCount)
        );
        assert_eq!(
            Generator::new(1, 51, 10).err(),
            Some(Error::InvalidInstrumentCount)
        );
        assert_eq!(Generator::new(1, 5, 0).err(), Some(Error::InvalidMaxBatch));
        assert_eq!(
            Generator::new(1, 5, MAX_BATCH + 1).err(),
            Some(Error::InvalidMaxBatch)
        );
    }

    #[test]
    fn rejects_batches_outside_the_preallocated_buffer() {
        let mut generator = Generator::new(1, 5, 100).unwrap();
        assert_eq!(generator.generate(0).err(), Some(Error::InvalidBatchSize));
        assert_eq!(generator.generate(101).err(), Some(Error::InvalidBatchSize));
        assert!(generator.generate(100).is_ok());
    }

    #[test]
    fn output_buffer_address_is_stable() {
        let mut generator = Generator::new(1, 5, 1_000).unwrap();
        let first = generator.generate(10).unwrap().as_ptr();
        let second = generator.generate(1_000).unwrap().as_ptr();
        assert_eq!(first, second);
    }
}
