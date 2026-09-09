use std::process::Command;

fn git_stdout(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn emit_git_rerun_if_changed() {
    // Prefer git-resolved paths so worktrees / non-standard .git layouts still work.
    if let Some(head_path) = git_stdout(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head_path}");
    }

    // On a normal branch, commits update refs/heads/<branch>, not HEAD.
    // Without watching that ref, incremental builds can keep a stale About SHA.
    if let Some(symref) = git_stdout(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(ref_path) = git_stdout(&["rev-parse", "--git-path", &symref]) {
            println!("cargo:rerun-if-changed={ref_path}");
        }
    }
    // Detached HEAD: only the HEAD path is needed.
}

fn main() {
    let sha = std::env::var("OC_CLAW_GIT_SHA")
        .or_else(|_| std::env::var("GITHUB_SHA"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| git_stdout(&["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());

    println!("cargo:rustc-env=OC_CLAW_GIT_SHA={sha}");
    println!("cargo:rerun-if-env-changed=OC_CLAW_GIT_SHA");
    println!("cargo:rerun-if-env-changed=GITHUB_SHA");
    emit_git_rerun_if_changed();
    tauri_build::build()
}