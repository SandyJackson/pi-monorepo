---
status: accepted
---

# Support local development and GitHub bootstrap installations

The Pi workspace supports both a local-path development installation and a GitHub package bootstrap installation. Both modes load the workspace's extensions and skills; workspace-owned agents remain source-controlled here but are manually copied into Pi's global agent directory during the initial migration. The local path preserves a fast edit-and-reload loop, while the GitHub source gives new machines a reproducible Pi-managed install and update path without requiring the source checkout to live at a fixed absolute path.
