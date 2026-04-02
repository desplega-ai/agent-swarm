#!/bin/bash
# === Agent-managed setup ===

# Install code analysis tools
echo "Installing UX analysis tools..."
sudo npm install -g react-scanner 2>/dev/null || true
sudo npm install -g dependency-cruiser 2>/dev/null || true

# eslint + jsx-a11y for accessibility analysis
sudo npm install -g eslint eslint-plugin-jsx-a11y 2>/dev/null || true

# Component documentation and AST analysis tools
sudo npm install -g react-docgen 2>/dev/null || true
sudo npm install -g @babel/core @babel/parser @babel/traverse 2>/dev/null || true

echo "UX Principles Agent setup complete."

# === End agent-managed setup ===
