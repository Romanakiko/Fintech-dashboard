//! Simulated market-update generator compiled to WebAssembly.
//!
//! The ABI is a few C-style exports over one module-level generator:
//! `init` (re)creates it and `generate(n)` fills a pre-allocated buffer with
//! `n` [`Update`]s, returning its address in linear memory. The worker reads
//! the batch through a `Uint32Array` view without copying.

mod generator;
mod model;
mod rng;

use std::cell::{Cell, RefCell};

pub use generator::{Error, Generator};
pub use model::{MAX_BATCH, MAX_INSTRUMENTS, UPDATE_STRIDE_U32, Update};

/// Bumped on any change to the exports or the [`Update`] layout.
pub const ABI_VERSION: u32 = 1;

thread_local! {
    static GENERATOR: RefCell<Option<Generator>> = const { RefCell::new(None) };
    static LAST_ERROR: Cell<i32> = const { Cell::new(0) };
}

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn update_stride() -> u32 {
    UPDATE_STRIDE_U32 as u32
}

/// Starts a new generator. Returns 0 on success or a negative [`Error`] code,
/// in which case the previous generator (if any) is left untouched.
#[unsafe(no_mangle)]
pub extern "C" fn init(seed_lo: u32, seed_hi: u32, instruments: u32, max_batch: u32) -> i32 {
    let seed = (u64::from(seed_hi) << 32) | u64::from(seed_lo);
    match Generator::new(seed, instruments, max_batch) {
        Ok(generator) => {
            GENERATOR.with_borrow_mut(|slot| *slot = Some(generator));
            0
        }
        Err(error) => error.code(),
    }
}

/// Generates `n` updates and returns their address, or null on error
/// (the reason is available from [`last_error`]).
#[unsafe(no_mangle)]
pub extern "C" fn generate(n: u32) -> *const Update {
    let result = GENERATOR.with_borrow_mut(|slot| match slot {
        Some(generator) => generator.generate(n).map(<[Update]>::as_ptr),
        None => Err(Error::NotInitialized),
    });
    match result {
        Ok(ptr) => {
            LAST_ERROR.set(0);
            ptr
        }
        Err(error) => {
            LAST_ERROR.set(error.code());
            std::ptr::null()
        }
    }
}

/// Error code of the most recent `generate` call, 0 if it succeeded.
#[unsafe(no_mangle)]
pub extern "C" fn last_error() -> i32 {
    LAST_ERROR.get()
}

#[cfg(test)]
mod tests {
    // Each #[test] runs on its own thread, so the thread-local generator is isolated per test.
    use super::*;

    #[test]
    fn exposes_abi_metadata() {
        assert_eq!(abi_version(), 1);
        assert_eq!(update_stride(), 7);
    }

    #[test]
    fn generate_before_init_fails() {
        assert!(generate(10).is_null());
        assert_eq!(last_error(), Error::NotInitialized.code());
    }

    #[test]
    fn generate_reads_back_the_same_stream_as_the_generator() {
        assert_eq!(init(0xdead_beef, 0x1234, 5, 100), 0);
        let ptr = generate(100);
        assert!(!ptr.is_null());
        assert_eq!(last_error(), 0);

        // SAFETY: `generate` succeeded, so `ptr` addresses 100 initialised updates
        // that stay valid until the next call into this module.
        let via_abi = unsafe { std::slice::from_raw_parts(ptr, 100) }.to_vec();
        let mut direct = Generator::new(0x1234_dead_beef, 5, 100).unwrap();
        assert_eq!(via_abi, direct.generate(100).unwrap());
    }

    #[test]
    fn failed_init_keeps_the_previous_generator() {
        assert_eq!(init(1, 0, 5, 10), 0);
        assert_eq!(init(1, 0, 0, 10), Error::InvalidInstrumentCount.code());
        assert!(!generate(10).is_null());
    }

    #[test]
    fn oversized_batch_reports_an_error() {
        assert_eq!(init(1, 0, 5, 10), 0);
        assert!(generate(11).is_null());
        assert_eq!(last_error(), Error::InvalidBatchSize.code());
    }
}
