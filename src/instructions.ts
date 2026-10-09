/**
 * The MCP `instructions` string this server sends in its initialize result.
 *
 * Hosts such as Yaw MCP render it once per session (capped at 2000 bytes), so
 * it is routing guidance only: which tool family answers which kind of
 * question, and that every tool is pure over its arguments. Plain ASCII, kept
 * well under the cap; src/instructions.test.ts pins both.
 */
export const SERVER_INSTRUCTIONS = [
  "Electron development knowledge. Every tool is read-only and pure over its arguments:",
  "it reads no project file, runs nothing and makes no network call, so pass the code,",
  "config or error text to analyze as a string argument.",
  "",
  "Routing:",
  "- Reviewing existing code: electron_audit_security, electron_lint_security,",
  "  electron_audit_ipc_security, electron_audit_performance.",
  "- Writing new code or config: electron_scaffold_project, electron_scaffold_ipc_channel,",
  "  electron_generate_preload_bridge, electron_generate_window_manager,",
  "  electron_configure_csp, electron_configure_fuses, electron_configure_auto_update,",
  "  electron_configure_deep_linking.",
  "- Upgrading Electron: electron_migrate_version for a version-to-version checklist,",
  "  electron_check_deprecated_apis to scan code for removed or deprecated APIs.",
  "- Build or packaging failures: electron_diagnose_build_error with the error output.",
  "- Concepts: electron_explain_process_model, electron_explain_concept.",
  "- electron_knowledge_version reports which Electron releases the embedded knowledge covers.",
].join("\n");
