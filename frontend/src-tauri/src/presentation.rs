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
    /// Raw reason bit set. Only for diagnostics and equality assertions — code
    /// must go through [`Suppression::active`].
    pub fn mask(&self) -> u8 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Human label for a single suppression reason (as passed to `set`).
pub fn reason_label(reason: u8) -> &'static str {
    match reason {
        FULLSCREEN => "FULLSCREEN",
        USER => "USER",
        _ => "UNKNOWN",
    }
}

/// Human label for a whole mask, so logs show which reasons are still held.
pub fn reasons_label(mask: u8) -> String {
    let mut active: Vec<&str> = Vec::new();
    if mask & USER != 0 {
        active.push("USER");
    }
    if mask & FULLSCREEN != 0 {
        active.push("FULLSCREEN");
    }
    if active.is_empty() {
        "NONE".to_string()
    } else {
        active.join("|")
    }
}

/// What a secondary launch (Start Menu / Desktop click, or a second exe while an
/// instance already runs) may do inside the primary instance.
///
/// `tauri-plugin-single-instance` reports the relaunch from *inside* the primary
/// process; its only responsibility is "the second process exits". It must not
/// touch presentation: re-showing the mini from this callback used to be a
/// native show path running outside the suppression reconciliation (and, on
/// Windows, it desynced tao's visibility bookkeeping — see
/// `set_presentation_native_visibility`). "Reveal the mascot on relaunch" is a
/// user-intent feature and belongs in an explicit, mask-aware reconciliation,
/// never in the single-instance callback.
#[derive(Debug, PartialEq)]
pub enum SecondaryLaunchAction {
    Ignore,
}

pub fn secondary_launch_action() -> SecondaryLaunchAction {
    SecondaryLaunchAction::Ignore
}

/// Late-bound gate for every native show of a presentation-owned window.
///
/// Callers must evaluate this at execution time on the UI thread — never when a
/// show is prepared or queued — so a suppression that lands in between still
/// wins (prepare -> suppress -> execute must not show).
pub fn show_is_allowed(suppressed: bool) -> bool {
    !suppressed
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

    /// USER suppression alone must hide every presentation-owned window,
    /// including the primary mini (the regression the Windows report describes:
    /// bubble hidden, mascot still on screen).
    #[test]
    fn user_suppression_hides_mini_and_bubble() {
        let state = Suppression::new();
        state.set(USER, true);
        assert_eq!(window_action("mini", state.active(), false), WindowAction::Hide);
        assert_eq!(window_action("mascot-bubble", state.active(), false), WindowAction::Hide);
        assert_eq!(reasons_label(state.mask()), "USER");
    }

    /// Same for the fullscreen watcher reason.
    #[test]
    fn fullscreen_suppression_hides_mini_and_bubble() {
        let state = Suppression::new();
        state.set(FULLSCREEN, true);
        assert_eq!(window_action("mini", state.active(), false), WindowAction::Hide);
        assert_eq!(window_action("mascot-bubble", state.active(), false), WindowAction::Hide);
        assert_eq!(reasons_label(state.mask()), "FULLSCREEN");
    }

    /// Holding USER + FULLSCREEN: releasing exactly one reason must keep hiding;
    /// only releasing both restores presentation.
    #[test]
    fn releasing_one_held_reason_keeps_hiding() {
        let state = Suppression::new();
        state.set(USER, true);
        state.set(FULLSCREEN, true);
        assert_eq!(reasons_label(state.mask()), "USER|FULLSCREEN");

        state.set(USER, false);
        assert!(state.active(), "FULLSCREEN is still held");
        for label in ["mini", "mascot-bubble", "extra-mascot-0"] {
            assert_eq!(window_action(label, state.active(), false), WindowAction::Hide);
        }

        state.set(FULLSCREEN, false);
        assert!(!state.active());
        assert_eq!(reasons_label(state.mask()), "NONE");
        assert_eq!(window_action("mini", state.active(), false), WindowAction::Show);
        assert_eq!(window_action("mascot-bubble", state.active(), false), WindowAction::ReconcileBubble);
    }

    /// A relaunch must be presentation-neutral in every mask state.
    #[test]
    fn secondary_launch_never_shows_and_never_mutates_presentation() {
        assert_eq!(secondary_launch_action(), SecondaryLaunchAction::Ignore);

        for suppressed in [false, true] {
            let state = Suppression::new();
            if suppressed {
                state.set(USER, true);
                state.set(FULLSCREEN, true);
            }
            let mask_before = state.mask();
            let active_before = state.active();

            // Applying the secondary-launch policy is a no-op on native
            // visibility: it can never yield Show/Hide and never edits the mask.
            let action = secondary_launch_action();
            assert_eq!(action, SecondaryLaunchAction::Ignore);
            assert_eq!(state.mask(), mask_before);
            assert_eq!(state.active(), active_before);
        }
    }

    /// A show prepared while presentation is free must not execute once a
    /// suppression lands in between (the gate is evaluated at execution time).
    #[test]
    fn show_prepared_before_suppression_does_not_show_after_it_lands() {
        let state = Suppression::new();

        let prepared = show_is_allowed(state.active());
        assert!(prepared, "nothing suppresses presentation yet");

        state.set(USER, true);
        assert!(!show_is_allowed(state.active()), "tray Hide landed before the queued show ran");

        state.set(USER, false);
        assert!(show_is_allowed(state.active()));

        state.set(FULLSCREEN, true);
        assert!(
            !show_is_allowed(state.active()),
            "fullscreen suppression landed before the queued show ran"
        );
    }
}
