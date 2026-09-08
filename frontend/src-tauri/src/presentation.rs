use std::sync::atomic::{AtomicU8, Ordering};

pub const FULLSCREEN: u8 = 1;
pub const USER: u8 = 2;

#[derive(Debug, PartialEq)]
pub enum WindowAction {
    Hide,
    Show,
    ReconcileBubble,
    Ignore,
}

pub fn window_action(label: &str, suppressed: bool, extras_hidden: bool) -> WindowAction {
    if label == "mascot-bubble" {
        return if suppressed {
            WindowAction::Hide
        } else {
            WindowAction::ReconcileBubble
        };
    }
    if label == "mini" || label.starts_with("extra-mascot-") {
        return if suppressed || (label != "mini" && extras_hidden) {
            WindowAction::Hide
        } else {
            WindowAction::Show
        };
    }
    WindowAction::Ignore
}

/// Independent reasons suppress presentation, never the bubble lifecycle.
#[derive(Default)]
pub struct Suppression(AtomicU8);

impl Suppression {
    pub const fn new() -> Self {
        Self(AtomicU8::new(0))
    }
    pub fn active(&self) -> bool {
        self.0.load(Ordering::SeqCst) != 0
    }
    pub fn set(&self, reason: u8, hidden: bool) {
        if hidden {
            self.0.fetch_or(reason, Ordering::SeqCst);
        } else {
            self.0.fetch_and(!reason, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_reasons_in_both_orders() {
        for (first, second) in [(FULLSCREEN, USER), (USER, FULLSCREEN)] {
            let state = Suppression::new();
            state.set(first, true);
            state.set(second, true);
            state.set(first, false);
            assert!(state.active());
            for label in ["mini", "mascot-bubble", "extra-mascot-0"] {
                assert_eq!(window_action(label, state.active(), false), WindowAction::Hide);
            }
            state.set(first, false);
            assert!(state.active());
            state.set(second, false);
            assert!(!state.active());
        }
    }

    #[test]
    fn tray_hides_all_owned_windows_and_restores_only_logically_visible_extras() {
        let state = Suppression::new();
        state.set(USER, true);
        for label in ["mini", "mascot-bubble", "extra-mascot-1"] {
            assert_eq!(window_action(label, state.active(), false), WindowAction::Hide);
        }
        assert_eq!(window_action("detail", state.active(), false), WindowAction::Ignore);
        state.set(USER, false);
        assert_eq!(window_action("mini", state.active(), true), WindowAction::Show);
        assert_eq!(window_action("extra-mascot-1", state.active(), true), WindowAction::Hide);
        assert_eq!(window_action("mascot-bubble", state.active(), false), WindowAction::ReconcileBubble);
    }
}
