// web/loyalty/adapters/clock.js
//
// A deterministic clock abstraction.
// Allows time-travel testing (especially for the 30-day pending points hold).

let _fixedTime = null;

/**
 * Returns the current date/time.
 * If setFixedTime has been called, returns that fixed time.
 * Otherwise, returns the real current Date.
 */
export function now() {
  if (_fixedTime !== null) {
    return new Date(_fixedTime.getTime());
  }
  return new Date();
}

/**
 * Fixes the clock to a specific time for testing.
 * @param {Date|string|number} time 
 */
export function setFixedTime(time) {
  _fixedTime = new Date(time);
}

/**
 * Restores the clock to real time.
 */
export function restoreClock() {
  _fixedTime = null;
}
