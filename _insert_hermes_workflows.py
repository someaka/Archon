#!/usr/bin/env python3
"""Insert Hermes workflow entries into bundled-defaults.generated.ts"""
import os

path = '/home/d/Desktop/Archon-canonical/packages/workflows/src/defaults/bundled-defaults.generated.ts'

with open(path, 'r') as f:
    content = f.read()

new_entries = '''  "hermes-local-review": "name: hermes-local-review\\ndescription: Code review using a local model via Hermes Agent\\n\\nnodes:\\n  - id: review\\n    prompt: |\\n      Review the following code for bugs, style issues, and security concerns. Be concise.\\n\\n      $USER_MESSAGE\\n    provider: hermes\\n    model: qwen2.5-coder:32b\\n",
  "plan-with-claude-implement-with-hermes": "name: plan-with-claude-implement-with-hermes\\ndescription: Plan with Claude, implement with a local Hermes model\\n\\nnodes:\\n  - id: plan\\n    prompt: |\\n      Create a detailed implementation plan for: $USER_MESSAGE\\n    provider: claude\\n    model: sonnet\\n  - id: implement\\n    prompt: |\\n      Implement the plan. Write clean, well-tested code.\\n\\n      Plan:\\n      $PLAN_OUTPUT\\n    provider: hermes\\n    model: qwen2.5-coder:32b\\n    depends_on: [plan]\\n",
'''

# Find the last '};'
last_brace = content.rfind('};')
if last_brace == -1:
    print('ERROR: could not find closing brace')
    exit(1)

# Insert before the last };
content = content[:last_brace] + new_entries + '\n' + content[last_brace:]

with open(path, 'w') as f:
    f.write(content)

print('Inserted successfully')
