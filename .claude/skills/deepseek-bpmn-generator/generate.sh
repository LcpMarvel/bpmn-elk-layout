#!/bin/bash
set -e

# DeepSeek BPMN Generator - Single Run
# Usage: ./generate.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$PROJECT_ROOT"

# Config
MODEL="deepseek-reasoner"
TEMPERATURE=0.3
API_URL="https://api.deepseek.com/v1/chat/completions"

# Check API key
if [ -z "$RAGENT_DEEPSEEK_APIKEY" ]; then
    echo "ERROR: RAGENT_DEEPSEEK_APIKEY environment variable is not set"
    exit 1
fi

# Check input files
if [ ! -f "prompt-template.md" ]; then
    echo "ERROR: prompt-template.md not found"
    exit 1
fi
if [ ! -f "user-prompt.md" ]; then
    echo "ERROR: user-prompt.md not found"
    exit 1
fi

# Create output directory
OUTPUT_DIR="output/$(date +%Y-%m-%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"
echo "Output directory: $OUTPUT_DIR"

# Copy prompt template for reference
cp prompt-template.md "$OUTPUT_DIR/prompt-template.md"

# Step 1: Read prompts
echo ""
echo "=== Step 1: Reading prompts ==="
SYSTEM_PROMPT=$(cat prompt-template.md)
USER_PROMPT=$(cat user-prompt.md)

# Step 2: Call DeepSeek API
echo ""
echo "=== Step 2: Calling DeepSeek API ($MODEL) ==="

REQUEST_FILE="$OUTPUT_DIR/request.json"
jq -n \
    --arg model "$MODEL" \
    --arg sys "$SYSTEM_PROMPT" \
    --arg usr "$USER_PROMPT" \
    --argjson temp "$TEMPERATURE" \
    '{
        model: $model,
        messages: [
            {role: "system", content: $sys},
            {role: "user", content: $usr}
        ],
        temperature: $temp
    }' > "$REQUEST_FILE"

RESPONSE_FILE="$OUTPUT_DIR/api-response.json"
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$RESPONSE_FILE" \
    "$API_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RAGENT_DEEPSEEK_APIKEY" \
    -d @"$REQUEST_FILE")

if [ "$HTTP_CODE" != "200" ]; then
    echo "ERROR: API returned HTTP $HTTP_CODE"
    cat "$RESPONSE_FILE"
    exit 1
fi

echo "API response received"

# Step 3: Extract JSON from response
echo ""
echo "=== Step 3: Extracting JSON ==="
CONTENT=$(jq -r '.choices[0].message.content // empty' "$RESPONSE_FILE")

if [ -z "$CONTENT" ]; then
    echo "ERROR: No content in API response"
    exit 1
fi

# Save raw content
echo "$CONTENT" > "$OUTPUT_DIR/raw-content.txt"

# Extract JSON block
JSON_FILE="$OUTPUT_DIR/response.json"
if echo "$CONTENT" | grep -q '```json'; then
    echo "$CONTENT" | sed -n '/```json/,/```/p' | sed '1d;$d' > "$JSON_FILE"
elif echo "$CONTENT" | grep -q '```'; then
    echo "$CONTENT" | sed -n '/```/,/```/p' | sed '1d;$d' > "$JSON_FILE"
else
    echo "$CONTENT" > "$JSON_FILE"
fi

# Validate JSON
if ! jq empty "$JSON_FILE" 2>/dev/null; then
    echo "ERROR: Invalid JSON extracted"
    echo "See raw content in: $OUTPUT_DIR/raw-content.txt"
    exit 1
fi

# Check for duplicate root-level children key (common DeepSeek issue)
CHILDREN_COUNT=$(grep -c '^\s*"children": \[' "$JSON_FILE" || echo "0")
if [ "$CHILDREN_COUNT" -gt 1 ]; then
    echo "WARNING: Found $CHILDREN_COUNT root-level children arrays, attempting fix..."
    python3 -c "
import re
with open('$JSON_FILE', 'r') as f:
    content = f.read()
matches = list(re.finditer(r'^  \"children\": \[', content, re.MULTILINE))
if len(matches) > 1:
    last_match = matches[-1]
    content = content[:last_match.start()].rstrip().rstrip(',') + '\n}'
with open('$JSON_FILE', 'w') as f:
    f.write(content)
" 2>/dev/null || true
    if ! jq empty "$JSON_FILE" 2>/dev/null; then
        echo "ERROR: Failed to fix duplicate children issue"
        exit 1
    fi
    echo "Fixed duplicate children array"
fi

echo "JSON extracted successfully"

# Step 4: Convert to BPMN
echo ""
echo "=== Step 4: Converting to BPMN ==="
BPMN_FILE="$OUTPUT_DIR/output.bpmn"
CONVERT_LOG="$OUTPUT_DIR/convert.log"

ABS_JSON_FILE="$PROJECT_ROOT/$JSON_FILE"
ABS_BPMN_FILE="$PROJECT_ROOT/$BPMN_FILE"
ABS_CONVERT_LOG="$PROJECT_ROOT/$CONVERT_LOG"
ABS_LAYOUTED_FILE="$PROJECT_ROOT/$OUTPUT_DIR/layouted.json"

if node "$PROJECT_ROOT/packages/bpmn-elk-layout/dist/bin/bpmn-elk-layout.js" convert "$ABS_JSON_FILE" -f bpmn -o "$ABS_BPMN_FILE" 2> "$ABS_CONVERT_LOG"; then
    echo "BPMN conversion successful"
    CONVERSION_OK=true
    node "$PROJECT_ROOT/packages/bpmn-elk-layout/dist/bin/bpmn-elk-layout.js" convert "$ABS_JSON_FILE" -f json -o "$ABS_LAYOUTED_FILE" 2>> "$ABS_CONVERT_LOG" || true
else
    echo "BPMN conversion failed"
    CONVERSION_OK=false
    cat "$ABS_CONVERT_LOG"
fi

# Step 5: Analyze JSON for issues
echo ""
echo "=== Step 5: Analyzing JSON structure ==="
ISSUES_FILE="$OUTPUT_DIR/issues.txt"
> "$ISSUES_FILE"

# Check: Lane under Process
if jq -e '.children[0].bpmn.type == "process" and (.children[0].children[]?.bpmn.type == "lane")' "$JSON_FILE" 2>/dev/null | grep -q true; then
    echo "CRITICAL: LANE_UNDER_PROCESS - Lanes placed directly under process" >> "$ISSUES_FILE"
fi

# Check: Missing eventDefinitionType
MISSING_EVENTS=$(jq -r '.. | objects | select(.bpmn.type? | test("Event$")?) | select(.bpmn.eventDefinitionType == null) | .id' "$JSON_FILE" 2>/dev/null | head -5)
if [ -n "$MISSING_EVENTS" ]; then
    echo "CRITICAL: MISSING_EVENT_DEFINITION - Events without eventDefinitionType: $MISSING_EVENTS" >> "$ISSUES_FILE"
fi

# Check: sequenceFlow in collaboration.edges
SEQ_IN_COLLAB=$(jq -r '.children[]? | select(.bpmn.type == "collaboration") | .edges[]? | select(.bpmn.type == "sequenceFlow") | .id' "$JSON_FILE" 2>/dev/null | head -3)
if [ -n "$SEQ_IN_COLLAB" ]; then
    echo "CRITICAL: SEQUENCE_FLOW_IN_COLLABORATION - sequenceFlow in collaboration.edges: $SEQ_IN_COLLAB" >> "$ISSUES_FILE"
fi

# Check: Nodes (gateways, events, tasks) in edges array
NODES_IN_EDGES=$(jq -r '.. | objects | select(.edges?) | .edges[]? | select(.bpmn.type? | test("Gateway$|Event$|Task$|activity|subProcess")?) | .id' "$JSON_FILE" 2>/dev/null | head -5)
if [ -n "$NODES_IN_EDGES" ]; then
    echo "CRITICAL: NODES_IN_EDGES - Gateways/events/tasks in edges array: $NODES_IN_EDGES" >> "$ISSUES_FILE"
fi

# Check: Missing referenced nodes
ALL_NODE_IDS=$(jq -r '.. | objects | select(.id? and .bpmn?) | .id' "$JSON_FILE" 2>/dev/null | sort -u)
EDGE_REFS=$(jq -r '.. | objects | select(.sources? or .targets?) | (.sources[]?, .targets[]?)' "$JSON_FILE" 2>/dev/null | sort -u)
MISSING_REFS=""
for ref in $EDGE_REFS; do
    if ! echo "$ALL_NODE_IDS" | grep -qx "$ref"; then
        MISSING_REFS="$MISSING_REFS $ref"
    fi
done
if [ -n "$MISSING_REFS" ]; then
    echo "CRITICAL: MISSING_REFERENCES - Edge references undefined nodes:$MISSING_REFS" >> "$ISSUES_FILE"
fi

# Count issues
CRITICAL_COUNT=$(grep -c "^CRITICAL:" "$ISSUES_FILE" 2>/dev/null || echo "0")

# Step 6: Generate report
echo ""
echo "=== Step 6: Generating report ==="

REPORT_FILE="$OUTPUT_DIR/analysis.md"
cat > "$REPORT_FILE" << EOF
# BPMN Generation Analysis Report

## Generation Info
- Timestamp: $(date '+%Y-%m-%d %H:%M:%S')
- Model: $MODEL
- Conversion: $([ "$CONVERSION_OK" = true ] && echo "SUCCESS" || echo "FAILED")
- Critical Issues: $CRITICAL_COUNT

## Output Files
EOF

for f in "$OUTPUT_DIR"/*; do
    echo "- $(basename "$f"): $(wc -c < "$f" | tr -d ' ') bytes" >> "$REPORT_FILE"
done

if [ -s "$ISSUES_FILE" ]; then
    cat >> "$REPORT_FILE" << EOF

## Issues Found
\`\`\`
$(cat "$ISSUES_FILE")
\`\`\`
EOF
fi

if [ "$CONVERSION_OK" = false ] && [ -s "$CONVERT_LOG" ]; then
    cat >> "$REPORT_FILE" << EOF

## Conversion Error
\`\`\`
$(cat "$CONVERT_LOG")
\`\`\`
EOF
fi

# Final summary
echo ""
echo "=========================================="
echo "Generation Complete!"
echo "=========================================="
echo ""
echo "Output Directory: $OUTPUT_DIR"
echo "Conversion: $([ "$CONVERSION_OK" = true ] && echo "SUCCESS" || echo "FAILED")"
echo "Critical Issues: $CRITICAL_COUNT"
if [ -s "$ISSUES_FILE" ]; then
    echo ""
    echo "Issues:"
    cat "$ISSUES_FILE"
fi
echo ""
echo "Files:"
ls -la "$OUTPUT_DIR"
echo ""
if [ "$CONVERSION_OK" = true ]; then
    echo "To preview: Open apps/bpmn-viewer and load $OUTPUT_DIR/output.bpmn"
else
    echo "Review issues and ask Claude Code to optimize prompt-template.md"
fi
