# HN Analyzer - Dataset

This folder contains documentation for the Hacker News attention dynamics dataset.

## Download

The full dataset is available on **Mendeley Data**:  
📊 **[Data for: Attention Dynamics in Online Communities](https://data.mendeley.com/datasets/XXXXX)** *(link pending)*

## Dataset Summary

| Metric | Value |
|--------|-------|
| **Collection period** | December 3–30, 2025 (27 days) |
| **Items** | 297,371 |
| **Temporal snapshots** | 72,227 |
| **Source** | Hacker News API via [hn-archiver](https://github.com/philippdubach/hn-archiver) |

## Files

| File | Description |
|------|-------------|
| `items.csv` | All HN content with AI-enriched metadata |
| `item_snapshots.csv` | Time-series score/comment observations |
| `analysis_results.json` | Pre-computed statistics from the paper |
| `README.md` | This documentation |

## Schema

### items.csv (297,371 rows)

All HN content: stories, comments, polls, and job postings.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | HN item ID (primary key) |
| type | TEXT | story, comment, poll, job, pollopt |
| by | TEXT | Username of submitter |
| time | INTEGER | Unix timestamp (seconds) |
| score | INTEGER | Current upvote count |
| descendants | INTEGER | Total comment count |
| title | TEXT | Story/poll title |
| url | TEXT | Linked URL |
| text | TEXT | Text content (for comments, text posts) |
| ai_topic | TEXT | AI-classified topic (13 categories) |
| ai_sentiment | REAL | Sentiment score (-1 to 1) |
| ai_content_type | TEXT | Content type classification |

### item_snapshots.csv (72,227 rows)

Temporal observations capturing score evolution over time.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Snapshot ID (primary key) |
| item_id | INTEGER | FK to items.id |
| captured_at | INTEGER | Unix timestamp (milliseconds) |
| score | INTEGER | Score at capture time |
| descendants | INTEGER | Comment count at capture time |
| snapshot_reason | TEXT | Trigger: score_spike, front_page, sample, new_item |

## Topic Categories

AI classification uses 13 categories:
- artificial-intelligence
- programming
- web-development
- startups
- science
- security
- crypto-blockchain
- hardware
- career
- politics
- business
- gaming
- other

## Query Examples

```python
import pandas as pd

# Load data
items = pd.read_csv('items.csv')
snapshots = pd.read_csv('item_snapshots.csv')

# High-score items with AI analysis
viral = items[(items['type'] == 'story') & (items['score'] > 100)]
print(viral[['id', 'title', 'score', 'ai_topic', 'ai_sentiment']].head(20))

# Calculate early velocity for lifecycle analysis
merged = snapshots.merge(items[['id', 'time']], left_on='item_id', right_on='id')
merged['age_hours'] = (merged['captured_at']/1000 - merged['time']) / 3600
```

## Data Limitations

1. **Snapshot bias**: High-engagement content sampled more frequently
2. **AI accuracy**: Topic/sentiment classification not human-validated
3. **API coverage**: Some items may have been missed during high-activity periods

## License

Data collected from public Hacker News API. CC BY 4.0.

## Citation

```bibtex
@dataset{dubach2025hndata,
  author = {Dubach, Philipp D.},
  title = {Data for: Attention Dynamics in Online Communities},
  year = {2025},
  publisher = {Mendeley Data},
  doi = {10.17632/XXXXX}
}
```
