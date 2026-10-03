//! Windows mascot floor constraints and read-only geometry for future animation policies.
//! Screen edges and the usable floor are separate: peeking may leave the screen
//! horizontally, but the visible body must stay above the taskbar.

use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use std::sync::atomic::{AtomicBool, Ordering};

/// Temporary layout ownership must end even if a monitor/window disappears.
/// Callers serialize transitions with PET_GEOMETRY_UPDATE_LOCK; only a completed
/// panel/settings layout may retain ownership beyond this scope.
#[cfg(any(target_os = "windows", test))]
pub struct MiniLayoutGuard<'a> {
    owned: &'a AtomicBool,
    release_on_drop: bool,
}

#[cfg(any(target_os = "windows", test))]
impl<'a> MiniLayoutGuard<'a> {
    fn new(owned: &'a AtomicBool) -> Self {
        owned.store(true, Ordering::SeqCst);
        Self {
            owned,
            release_on_drop: true,
        }
    }

    pub fn release(&mut self) {
        self.owned.store(false, Ordering::SeqCst);
    }

    pub fn keep_owned(mut self) {
        self.release_on_drop = false;
    }
}

#[cfg(any(target_os = "windows", test))]
impl Drop for MiniLayoutGuard<'_> {
    fn drop(&mut self) {
        if self.release_on_drop {
            self.release();
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn mini_layout_owned(owned: &AtomicBool, expanded: bool) -> bool {
    owned.load(Ordering::SeqCst) || expanded
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn valid(self) -> bool {
        [self.left, self.top, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && self.width > 0.0
            && self.height > 0.0
    }

    fn bottom(self) -> f64 {
        self.top + self.height
    }

    fn scaled(self, scale: f64) -> Self {
        Self {
            left: self.left * scale,
            top: self.top * scale,
            width: self.width * scale,
            height: self.height * scale,
        }
    }

    fn translated(self, x: f64, y: f64) -> Self {
        Self {
            left: self.left + x,
            top: self.top + y,
            ..self
        }
    }
}

/// Physical coordinates throughout, including negative monitor origins. Only
/// Y is constrained, so cross-monitor dragging and horizontal peeking survive.
fn floor_y(requested_y: f64, local_body: Rect, work_area: Rect) -> f64 {
    requested_y.min((work_area.bottom() - local_body.bottom()).floor())
}

fn reserve_auto_hide_floor(screen: Rect, work_area: Rect, taskbar_height: f64) -> Rect {
    let bottom = work_area.bottom().min(screen.bottom() - taskbar_height);
    Rect {
        height: (bottom - work_area.top).max(0.0),
        ..work_area
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub window_label: String,
    pub display_id: String,
    pub scale_factor: f64,
    pub monitor: Rect,
    pub work_area: Rect,
    pub body: Rect,
    pub distance_left: f64,
    pub distance_right: f64,
    pub distance_bottom: f64,
    pub auto_hide_reserved: bool,
}

#[cfg(target_os = "windows")]
pub mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromRect, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Shell::{
        SHAppBarMessage, ABE_BOTTOM, ABM_GETAUTOHIDEBAREX, APPBARDATA,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };

    // The probe's full rotation envelope is distinct from its interaction hitbox.
    // Canvas dimensions prevent a stale probe envelope constraining a panel.
    static MOTION_BOUNDS: Mutex<Vec<(String, f64, f64, Rect)>> = Mutex::new(Vec::new());
    static MINI_LAYOUT_OWNED: AtomicBool = AtomicBool::new(false);

    pub fn begin_mini_layout() -> MiniLayoutGuard<'static> {
        MiniLayoutGuard::new(&MINI_LAYOUT_OWNED)
    }

    pub fn layout_owned(win: &tauri::WebviewWindow) -> bool {
        win.label() == "mini"
            && mini_layout_owned(
                &MINI_LAYOUT_OWNED,
                crate::MINI_IS_EXPANDED.load(Ordering::SeqCst),
            )
    }

    pub fn set_motion_bounds(label: &str, canvas_w: f64, canvas_h: f64, bounds: Option<Rect>) {
        let mut entries = MOTION_BOUNDS.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|entry| entry.0 != label);
        if let Some(bounds) = bounds {
            entries.push((label.to_string(), canvas_w, canvas_h, bounds));
        }
    }

    fn local_body(win: &tauri::WebviewWindow) -> Result<Rect, String> {
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let size = win.outer_size().map_err(|e| e.to_string())?;
        let width = size.width as f64 / scale;
        let height = size.height as f64 / scale;
        Ok(body_for_frame(win, width, height))
    }

    pub fn body_for_frame(win: &tauri::WebviewWindow, width: f64, height: f64) -> Rect {
        if let Some((_, _, _, bounds)) = MOTION_BOUNDS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(label, w, h, _)| {
                label == win.label() && (w - width).abs() <= 2.0 && (h - height).abs() <= 2.0
            })
        {
            return *bounds;
        }
        if let Some(entry) = crate::get_mascot_hitbox_entry(win.label())
            .filter(|entry| crate::registered_entry_matches_frame(width, height, *entry))
        {
            return Rect {
                left: entry.hitbox_x,
                top: entry.hitbox_y,
                width: entry.hitbox_w,
                height: entry.hitbox_h,
            };
        }
        Rect {
            left: 0.0,
            top: 0.0,
            width,
            height,
        }
    }

    fn rect(value: RECT) -> Rect {
        Rect {
            left: value.left as f64,
            top: value.top as f64,
            width: (value.right - value.left) as f64,
            height: (value.bottom - value.top) as f64,
        }
    }

    fn display(body: Rect) -> Result<(String, Rect, Rect, bool), String> {
        let target = RECT {
            left: body.left.floor() as i32,
            top: body.top.floor() as i32,
            right: (body.left + body.width).ceil() as i32,
            bottom: body.bottom().ceil() as i32,
        };
        let monitor = unsafe { MonitorFromRect(&target, MONITOR_DEFAULTTONEAREST) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
            return Err("failed to read mascot monitor work area".into());
        }
        let screen = rect(info.rcMonitor);
        let mut work_area = rect(info.rcWork);
        // rcWork includes an auto-hidden taskbar's space. Ask the shell for
        // the bottom auto-hide bar on this exact monitor (including secondary
        // taskbars), and reserve its full height even while it is retracted.
        let mut bar = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            uEdge: ABE_BOTTOM,
            rc: info.rcMonitor,
            ..Default::default()
        };
        let bar_hwnd = unsafe { SHAppBarMessage(ABM_GETAUTOHIDEBAREX, &mut bar) };
        let mut auto_hide_reserved = false;
        if bar_hwnd != 0 {
            let mut bounds = RECT::default();
            if unsafe { GetWindowRect(HWND(bar_hwnd as _), &mut bounds) }.is_ok() {
                let height = (bounds.bottom - bounds.top) as f64;
                if height > 0.0 && height < screen.height {
                    work_area = reserve_auto_hide_floor(screen, work_area, height);
                    auto_hide_reserved = true;
                }
            }
        }
        Ok((
            format!("{:p}", monitor.0),
            screen,
            work_area,
            auto_hide_reserved,
        ))
    }

    /// Return a safe logical origin before any native move/resize. Target-body
    /// selection allows crossing monitors instead of pinning the original one.
    pub fn constrain(
        win: &tauri::WebviewWindow,
        x: f64,
        y: f64,
        body: Rect,
    ) -> Result<(f64, f64), String> {
        if layout_owned(win) {
            return Ok((x, y));
        }
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let physical_body = body.scaled(scale);
        let (_, _, work_area, _) = display(physical_body.translated(x * scale, y * scale))?;
        Ok((x, floor_y(y * scale, physical_body, work_area) / scale))
    }

    fn set_physical_position(win: &tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
        let hwnd = win.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            SetWindowPos(
                HWND(hwnd.0 as _),
                HWND::default(),
                x.round() as i32,
                y.floor() as i32,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
            )
        }
        .map_err(|e| e.to_string())
    }

    pub fn set_position(win: &tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
        if !x.is_finite() || !y.is_finite() {
            return Err("invalid mascot origin".into());
        }
        let (x, y) = constrain(win, x, y, local_body(win)?)?;
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        set_physical_position(win, x * scale, y * scale)?;
        // Moving to another DPI may change both the scale and native size.
        // Re-evaluate in physical coordinates without rescaling the origin.
        reconcile(win)?;
        Ok(())
    }

    pub fn snapshot(win: &tauri::WebviewWindow) -> Result<Snapshot, String> {
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let body = local_body(win)?
            .scaled(scale)
            .translated(pos.x as f64, pos.y as f64);
        let (display_id, monitor, work_area, auto_hide_reserved) = display(body)?;
        Ok(Snapshot {
            window_label: win.label().to_string(),
            display_id,
            scale_factor: scale,
            monitor,
            work_area,
            body,
            distance_left: body.left - monitor.left,
            distance_right: monitor.left + monitor.width - body.left - body.width,
            distance_bottom: work_area.bottom() - body.bottom(),
            auto_hide_reserved,
        })
    }

    pub fn reconcile(win: &tauri::WebviewWindow) -> Result<bool, String> {
        reconcile_body(win, local_body(win)?)
    }

    pub fn reconcile_body(win: &tauri::WebviewWindow, body: Rect) -> Result<bool, String> {
        if layout_owned(win) {
            return Ok(false);
        }
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let pos = win.outer_position().map_err(|e| e.to_string())?;
        let physical_body = body.scaled(scale);
        let (_, _, work_area, _) = display(physical_body.translated(pos.x as f64, pos.y as f64))?;
        let safe_y = floor_y(pos.y as f64, physical_body, work_area);
        if safe_y >= pos.y as f64 {
            return Ok(false);
        }
        set_physical_position(win, pos.x as f64, safe_y)?;
        Ok(true)
    }

    /// Reconcile display/taskbar settings, native resizes and restored frames.
    /// Explicit drag moves are constrained before mutation; this loop handles
    /// changes that do not travel through a movement command. It owns no animation.
    pub fn poll(app: tauri::AppHandle) {
        let mut previous = HashMap::<String, Snapshot>::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let Ok(_guard) = crate::PET_GEOMETRY_UPDATE_LOCK.try_lock() else {
                continue;
            };
            let windows = app.webview_windows();
            MOTION_BOUNDS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|entry| windows.contains_key(&entry.0));
            previous.retain(|label, _| windows.contains_key(label));
            let mut mini_moved = false;
            for (label, win) in windows {
                if !is_mascot_label(&label) || layout_owned(&win) {
                    previous.remove(&label);
                    continue;
                }
                let before = win.outer_position().ok();
                if let Ok(moved) = reconcile(&win) {
                    if moved && label == "mini" {
                        if let (Some(before), Ok(after), Ok(size), Ok(scale)) = (
                            before,
                            win.outer_position(),
                            win.outer_size(),
                            win.scale_factor(),
                        ) {
                            crate::set_mini_window_frame((
                                after.x as f64 / scale,
                                after.y as f64 / scale,
                                size.width as f64 / scale,
                                size.height as f64 / scale,
                            ));
                            crate::translate_mini_video_pet_body_anchor(
                                (after.x - before.x) as f64 / scale,
                                (after.y - before.y) as f64 / scale,
                            );
                            mini_moved = true;
                        }
                    }
                }
                if let Ok(state) = snapshot(&win) {
                    if previous.get(&label) != Some(&state) {
                        let _ = win.emit_to(
                            tauri::EventTarget::WebviewWindow {
                                label: label.clone(),
                            },
                            "mascot-geometry-changed",
                            &state,
                        );
                        previous.insert(label, state);
                    }
                }
            }
            drop(_guard);
            if mini_moved {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let geom = *crate::BUBBLE_GEOMETRY.lock().unwrap();
                    let _ = crate::sync_mascot_bubble(
                        app,
                        geom.width,
                        geom.height,
                        Some(geom.reserve_x),
                        Some(geom.reserve_y),
                        Some(false),
                        None,
                        Some("taskbar-floor-changed".into()),
                    )
                    .await;
                });
            }
        }
    }
}

pub fn is_mascot_label(label: &str) -> bool {
    label == "mini" || label.starts_with("extra-mascot-") || label.starts_with("demo-mascot-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapse_and_settings_restore_resume_floor_after_monitor_recovers() {
        // Both commands clear MINI_IS_EXPANDED before looking up the monitor.
        // A missing monitor skips the resize; an API/window error may return early.
        fn interrupted_restore(
            owned: &AtomicBool,
            monitor: Result<Option<Rect>, &'static str>,
        ) -> Result<(), &'static str> {
            let _layout_guard = MiniLayoutGuard::new(owned);
            let _monitor = monitor?;
            Ok(())
        }

        let work = Rect {
            left: 0.0,
            top: 0.0,
            width: 1920.0,
            height: 1032.0,
        };
        let body = Rect {
            left: 0.0,
            top: 20.0,
            width: 100.0,
            height: 140.0,
        };
        for was_owned in [false, true] {
            for unavailable in [Ok(None), Err("monitor unavailable")] {
                let owned = AtomicBool::new(was_owned);
                assert_eq!(
                    interrupted_restore(&owned, unavailable),
                    unavailable.map(|_| ())
                );
                // The same ownership check gates both poll and constrain. Once
                // the monitor is back, no further layout command is needed.
                assert!(!mini_layout_owned(&owned, false));
                let recovered_y = if mini_layout_owned(&owned, false) {
                    950.0
                } else {
                    floor_y(950.0, body, work)
                };
                assert_eq!(recovered_y, 872.0);
                assert_eq!(body.translated(0.0, recovered_y).bottom(), work.bottom());
            }
        }
    }

    #[test]
    fn collapsed_resize_releases_before_floor_check_and_on_later_error() {
        let owned = AtomicBool::new(true);
        let failed_resize = (|| -> Result<(), &'static str> {
            let mut guard = MiniLayoutGuard::new(&owned);
            assert!(mini_layout_owned(&owned, false));
            guard.release();
            assert!(!mini_layout_owned(&owned, false));
            Err("native resize failed")
        })();
        assert!(failed_resize.is_err());
        assert!(!mini_layout_owned(&owned, false));
    }

    #[test]
    fn completed_panel_or_settings_layout_keeps_ownership_until_restore() {
        let owned = AtomicBool::new(false);
        MiniLayoutGuard::new(&owned).keep_owned();
        assert!(mini_layout_owned(&owned, false)); // Settings need no expanded flag.
        assert!(mini_layout_owned(&owned, true));
        drop(MiniLayoutGuard::new(&owned));
        assert!(!mini_layout_owned(&owned, false));
    }

    #[test]
    fn floor_uses_body_not_transparent_canvas_and_preserves_horizontal_peek() {
        let body = Rect {
            left: 80.0,
            top: 20.0,
            width: 100.0,
            height: 140.0,
        };
        let work = Rect {
            left: 0.0,
            top: 0.0,
            width: 1920.0,
            height: 1032.0,
        };
        assert_eq!(floor_y(950.0, body, work), 872.0);
        assert_eq!(floor_y(500.0, body, work), 500.0);
        // X deliberately remains outside the screen during a left-edge probe.
        let placed = body.translated(-125.0, floor_y(950.0, body, work));
        assert_eq!(placed.left, -45.0);
        assert_eq!(placed.bottom(), work.bottom());
    }

    #[test]
    fn floor_handles_negative_monitor_origins_and_fractional_dpi_without_rounding_below_it() {
        let work = Rect {
            left: -1920.0,
            top: -1080.0,
            width: 1920.0,
            height: 1032.0,
        };
        let body = Rect {
            left: 10.0,
            top: 20.0,
            width: 129.0,
            height: 140.0,
        }
        .scaled(1.5);
        let y = floor_y(-100.0, body, work);
        assert_eq!(y, -288.0);
        assert!(body.translated(-1000.0, y).bottom() <= work.bottom());
        let fractional = Rect {
            height: 140.3,
            ..body
        };
        assert!(
            fractional
                .translated(0.0, floor_y(100.0, fractional, work))
                .bottom()
                <= work.bottom()
        );
    }

    #[test]
    fn auto_hide_reserves_full_bar_height_without_double_subtracting_visible_taskbar() {
        let screen = Rect {
            left: 1920.0,
            top: -200.0,
            width: 2560.0,
            height: 1440.0,
        };
        let visible_work = Rect {
            height: 1368.0,
            ..screen
        };
        assert_eq!(reserve_auto_hide_floor(screen, screen, 72.0), visible_work);
        assert_eq!(
            reserve_auto_hide_floor(screen, visible_work, 72.0),
            visible_work
        );
    }

    #[test]
    fn taller_than_work_area_still_keeps_bottom_above_taskbar() {
        let work = Rect {
            left: 0.0,
            top: 0.0,
            width: 800.0,
            height: 100.0,
        };
        let body = Rect {
            left: 0.0,
            top: 8.0,
            width: 100.0,
            height: 200.0,
        };
        assert_eq!(
            body.translated(0.0, floor_y(0.0, body, work)).bottom(),
            100.0
        );
    }

    #[test]
    fn geometry_is_scoped_to_mascots_and_rejects_invalid_bounds() {
        assert!(is_mascot_label("mini"));
        assert!(is_mascot_label("extra-mascot-1"));
        assert!(!is_mascot_label("mascot-bubble"));
        assert!(!is_mascot_label("detail"));
        assert!(!Rect {
            left: 0.0,
            top: f64::NAN,
            width: 10.0,
            height: 10.0
        }
        .valid());
    }
}
