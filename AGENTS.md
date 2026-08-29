# Guidelines for AI Agents

## 1. Language and Code Comments Policy
- **STRICT PROHIBITION**: NEVER write code comments, docstrings, log messages, or documentation in Chinese or other non-Latin/non-Cyrillic unknown languages.
- **Allowed Languages**: All code comments, docstrings, and technical documentation must be written strictly in **English** (or Russian when specifically requested by the user).
- **Existing Comments**: When modifying files with legacy Chinese comments, translate them to clear, high-fidelity English, fully preserving the architectural reasoning, or remove only truly obsolete notes.

## 2. Code Quality & Precision
- Always follow surgical precision and exact match editing rules.
- Do not make assumptions, never suppress errors with blind `try/except` or `true` fallback.
- Write clean, self-documenting code with concise English comments when necessary.

## 3. Preserving Architectural Context & Rationale
- **Preserve the "Why"**: Legacy comments in this codebase often contain in-depth technical essays explaining subtle OS edge cases, race conditions, hardware quirks, and why specific design decisions were made.
- **High-Fidelity Translation**: When translating legacy comments from Chinese to English, you MUST fully preserve the technical depth, nuances, and underlying rationale. Never blindly truncate, over-summarize, or strip away vital architectural context.
