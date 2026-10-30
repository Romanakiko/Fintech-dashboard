//! Market domain: the update record shared with JS and the per-instrument
//! price model.

use crate::rng::Pcg32;

/// Limits mirrored by the settings validation in the Angular app.
pub const MAX_INSTRUMENTS: u32 = 50;
pub const MAX_BATCH: u32 = 1_000;

/// $1.00 floor keeps every price positive.
pub const MIN_PRICE_CENTS: i64 = 100;
/// $100,000 ceiling keeps prices well inside `u32`.
pub const MAX_PRICE_CENTS: i64 = 10_000_000;
pub const MAX_SPREAD_CENTS: i64 = 10;
pub const MAX_BOOK_QTY: i64 = 10_000;
pub const MAX_TRADE_QTY: u32 = 1_000;

/// One simulated trade plus the top-of-book snapshot it happened against.
///
/// `repr(C)` fixes the layout read by the worker: 7 consecutive `u32` values.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Update {
    pub instrument: u32,
    pub price_cents: u32,
    pub trade_qty: u32,
    pub bid_cents: u32,
    pub ask_cents: u32,
    pub bid_qty: u32,
    pub ask_qty: u32,
}

pub const UPDATE_STRIDE_U32: usize = size_of::<Update>() / size_of::<u32>();

#[derive(Clone, Debug)]
pub struct InstrumentState {
    /// Long-run price level the bid reverts to.
    anchor: i64,
    bid: i64,
    spread: i64,
    bid_qty: i64,
    ask_qty: i64,
}

impl InstrumentState {
    pub fn random(rng: &mut Pcg32) -> Self {
        let anchor = rng.between(1_000, 50_000); // $10 – $500
        Self {
            anchor,
            bid: anchor,
            spread: rng.between(1, 5),
            bid_qty: rng.between(100, 2_000),
            ask_qty: rng.between(100, 2_000),
        }
    }

    /// Evolves the book by one step and returns the trade printed against it.
    pub fn step(&mut self, index: u32, rng: &mut Pcg32) -> Update {
        // Mean-reverting random walk: steps of about 5 bps, gentle pull to the anchor.
        let max_step = 1 + self.bid / 2_000;
        let reversion = (self.anchor - self.bid) / 256;
        self.bid = (self.bid + rng.between(-max_step, max_step) + reversion)
            .clamp(MIN_PRICE_CENTS, MAX_PRICE_CENTS);
        self.spread = (self.spread + rng.between(-1, 1)).clamp(1, MAX_SPREAD_CENTS);
        self.bid_qty = (self.bid_qty + rng.between(-50, 50)).clamp(0, MAX_BOOK_QTY);
        self.ask_qty = (self.ask_qty + rng.between(-50, 50)).clamp(0, MAX_BOOK_QTY);

        let ask = self.bid + self.spread;
        // Buyer-initiated trades lift the ask; seller-initiated trades hit the bid.
        let price = if rng.coin() { ask } else { self.bid };

        // The clamps above bound every value to 0..=MAX_PRICE_CENTS + MAX_SPREAD_CENTS.
        Update {
            instrument: index,
            price_cents: price as u32,
            trade_qty: trade_qty(rng),
            bid_cents: self.bid as u32,
            ask_cents: ask as u32,
            bid_qty: self.bid_qty as u32,
            ask_qty: self.ask_qty as u32,
        }
    }
}

/// Mostly small trades with an occasional block, in `1..=MAX_TRADE_QTY`.
fn trade_qty(rng: &mut Pcg32) -> u32 {
    let lot = 1 + rng.below(100);
    let multiplier = if rng.below(10) == 0 {
        1 + rng.below(10)
    } else {
        1
    };
    (lot * multiplier).min(MAX_TRADE_QTY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_is_seven_packed_u32() {
        assert_eq!(UPDATE_STRIDE_U32, 7);
        assert_eq!(size_of::<Update>(), 28);
    }

    #[test]
    fn trade_qty_covers_its_range() {
        let mut rng = Pcg32::new(3, 3);
        let qtys: Vec<u32> = (0..100_000).map(|_| trade_qty(&mut rng)).collect();
        assert!(qtys.iter().all(|q| (1..=MAX_TRADE_QTY).contains(q)));
        assert!(qtys.contains(&1));
        assert!(qtys.iter().any(|&q| q > 100), "block trades should occur");
    }
}
