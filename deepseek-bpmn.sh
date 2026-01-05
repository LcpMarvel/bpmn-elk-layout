#!/bin/bash

# DeepSeek BPMN JSON Generator
# Usage: ./deepseek-bpmn.sh [user-prompt-file]
# Default user prompt file: ./user-prompt.md

set -e

# Configuration
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
API_URL="https://api.deepseek.com/chat/completions"
MODEL="deepseek-reasoner"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# System prompt file (relative to script)
SYSTEM_PROMPT_FILE="${SCRIPT_DIR}/prompt-template.md"

# User prompt file (default or specified)
USER_PROMPT_FILE="${1:-${SCRIPT_DIR}/user-prompt.md}"

# Check API key
if [ -z "$DEEPSEEK_API_KEY" ]; then
    echo "Error: DEEPSEEK_API_KEY environment variable is not set" >&2
    echo "Usage: DEEPSEEK_API_KEY=your_key $0 [user-prompt-file]" >&2
    exit 1
fi

# Check system prompt file
if [ ! -f "$SYSTEM_PROMPT_FILE" ]; then
    echo "Error: System prompt file not found: $SYSTEM_PROMPT_FILE" >&2
    exit 1
fi

# Check user prompt file
if [ ! -f "$USER_PROMPT_FILE" ]; then
    echo "Error: User prompt file not found: $USER_PROMPT_FILE" >&2
    echo "Please create user-prompt.md in the current directory or specify a file path" >&2
    exit 1
fi

# Read prompts
SYSTEM_PROMPT=$(cat "$SYSTEM_PROMPT_FILE")
USER_PROMPT=$(cat "$USER_PROMPT_FILE")

# Build JSON payload using jq
PAYLOAD=$(jq -n \
    --arg model "$MODEL" \
    --arg system "$SYSTEM_PROMPT" \
    --arg user "$USER_PROMPT" \
    '{
        model: $model,
        messages: [
            { role: "system", content: $system },
            { role: "user", content: $user }
        ]
    }')

# Make API request and extract content
RESPONSE=$(curl -s "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
    -d "$PAYLOAD")

# Extract content from response
CONTENT=$(echo "$RESPONSE" | jq -r '.choices[0].message.content // empty')

# Check if content is empty (API error)
if [ -z "$CONTENT" ]; then
    echo "Error: Failed to get content from API response" >&2
    echo "Full response:" >&2
    echo "$RESPONSE" | jq . >&2
    exit 1
fi

# Remove markdown code block markers (```json and ```)
# Handle both ```json and ``` variants
CLEANED=$(echo "$CONTENT" | sed 's/^```json[[:space:]]*$//' | sed 's/^```[[:space:]]*$//' | sed '/^$/d')

# Output the cleaned JSON, formatted with jq
echo "$CLEANED" | jq .
