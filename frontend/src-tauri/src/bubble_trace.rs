use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

static BUBBLE_TRACE_ENABLED: AtomicBool = AtomicBool::new(false);
static TRACE_SEQ: AtomicU64 = AtomicU64::new(1);
static START_INSTANT: OnceLock<Instant> = OnceLock::new();

pub fn init() {
    let env_enabled = std::env::var("OC_BUBBLE_TRACE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if env_enabled {
        BUBBLE_TRACE_ENABLED.store(true, Ordering::SeqCst);
    }
}

pub fn is_enabled() -> bool {
    BUBBLE_TRACE_ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(enabled: bool) {
    BUBBLE_TRACE_ENABLED.store(enabled, Ordering::SeqCst);
}

pub fn monotonic_ms() -> u128 {
    START_INSTANT
        .get_or_init(Instant::now)
        .elapsed()
        .as_millis()
}

pub fn next_seq() -> u64 {
    TRACE_SEQ.fetch_add(1, Ordering::SeqCst)
}

/// Emit structured bubble diagnostic trace into standard log sink.
pub fn trace(layer: &str, event: &str, transition_id: Option<i64>, details: &[(&str, &str)]) {
    if !is_enabled() {
        return;
    }
    let seq = next_seq();
    let t = monotonic_ms();
    let transition_str = transition_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "none".to_string());

    let mut msg = format!(
        "[bubble-trace] seq={} t={} transition={} layer={} event={}",
        seq, t, transition_str, layer, event
    );
    for (k, v) in details {
        msg.push(' ');
        msg.push_str(k);
        msg.push('=');
        msg.push_str(v);
    }
    log::info!("{}", msg);
}

#[cfg(target_os = "windows")]
pub mod win32 {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowRect, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOPMOST,
    };

    pub fn get_rect(hwnd: HWND) -> Option<[i32; 4]> {
        let mut r = RECT::default();
        unsafe {
            if GetWindowRect(hwnd, &mut r).is_ok() {
                Some([r.left, r.top, r.right - r.left, r.bottom - r.top])
            } else {
                None
            }
        }
    }

    pub fn is_visible(hwnd: HWND) -> bool {
        unsafe { IsWindowVisible(hwnd).as_bool() }
    }

    pub fn is_topmost(hwnd: HWND) -> bool {
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            (ex_style as u32 & WS_EX_TOPMOST.0) != 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trace_sequence_monotonicity() {
        let seq1 = next_seq();
        let seq2 = next_seq();
        let seq3 = next_seq();
        assert!(seq2 > seq1);
        assert!(seq3 > seq2);
    }

    #[test]
    fn test_trace_disabled_is_noop() {
        set_enabled(false);
        assert!(!is_enabled());
        // Should not panic or perform operations
        trace("frontend", "test-event", Some(1), &[("key", "val")]);
    }

    #[test]
    fn test_monotonic_clock_non_decreasing() {
        let t1 = monotonic_ms();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t2 = monotonic_ms();
        assert!(t2 >= t1);
    }
}
