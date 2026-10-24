/** Representative official pricing.md sections, including competing tiers. */
export const PRICING_MARKDOWN = `# Pricing
Standard
### Standard pricing data
| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |
| gpt-6.1-sol | $2.00 | $10.00 | $0.10 | $2.50 | $5.00 | $4.00 | $15.00 | $0.20 | $5.00 | $10.00 |
| gpt-6-luna | $0.10 | $0.50 | $0.01 | $0.125 | $0.25 | $0.20 | $0.75 | $0.02 | $0.25 | $0.50 |
| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $30.00 | $0.80 | $10.00 | $20.00 |
| gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |

### Batch pricing data
#### Batch
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.375 | $2.25 | $0.0375 |
#### Flex
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.375 | $2.25 | $0.0375 |
Fast
### Fast pricing data
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $1.50 | $9.00 | $0.15 |
Ultrafast
### Ultrafast pricing data
Short context: ≤272K input tokens. Long context: >272K input tokens.

Specialized models
Standard
### Grouped Pricing Table data
| Category | Model | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $14.00 | $0.175 |
| Embedding | text-embedding-3-small | $0.02 | - | - |
Fast
### Grouped Pricing Table data
| Category | Model | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $28.00 | $0.35 |
Finetuning
Standard
### Pricing Table data
| Model | Training | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-5.4-mini | $25.00 | $3.00 | $12.00 | $0.75 |
`;
