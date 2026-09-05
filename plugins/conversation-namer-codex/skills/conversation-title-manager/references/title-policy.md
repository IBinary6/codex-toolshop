# Shared conversation title policy

- Derive the date from the conversation's `createdAt` converted to the IANA time zone `Asia/Shanghai`. Never use `updatedAt`, the current date, or a filesystem timestamp.
- Format every changed title as `MMDD｜TYPE｜Topic`, using the fullwidth separator `｜`.
- Choose TYPE by the conversation's actual central purpose:
  - `FEA` / `功能`: feature implementation
  - `DES` / `设计`: design or architecture
  - `FIX` / `修复`: bug diagnosis and fix
  - `OPT` / `优化`: optimization or improvement
  - `REL` / `发布`: release, commit, push, packaging, or deployment
  - `EXP` / `探索`: exploratory investigation
  - `DOC` / `文档`: documentation work
  - `RES` / `研究`: evidence-based research
- English TYPE codes are the default. Use Chinese TYPE labels only when the initiating user request explicitly asks for Chinese labels.
- Use one TYPE language across a whole batch. Never mix English codes and Chinese labels in the same run.
- Topic must briefly and specifically summarize what the conversation is actually about. Do not repeat the project name.
- Keep the complete title short enough to scan in the Codex sidebar. Remove filler such as “new conversation”, “discussion”, or “help me” when it does not distinguish the task.
- If the central topic cannot be determined reliably, do not invent one and do not change the existing title.
