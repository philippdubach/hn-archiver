# HN Analyzer

Analysis code and research outputs for studying attention dynamics on Hacker News.

## Research Paper

**"Attention Dynamics in Online Communities: Power Laws, Preferential Attachment, and Early Success Prediction on Hacker News"**

- **PDF**: [paper/hn_behavioral_paper.pdf](paper/hn_behavioral_paper.pdf)
- **LaTeX**: [paper/hn_behavioral_paper.tex](paper/hn_behavioral_paper.tex)

## Key Findings

| Metric | Value | Interpretation |
|--------|-------|----------------|
| **Gini coefficient** | 0.89 | Extreme attention inequality |
| **Matthew effect ρ** | −0.04 | Absent preferential attachment |
| **Early velocity ρ** | 0.82 | Strong predictor of final success |
| **Viral precision** | 98.4% | Top-quintile velocity identifies viral posts |
| **Decay exponent α** | 0.52 | Sub-linear power-law decay |

## Dataset

**297,371 items** with **72,227 temporal snapshots** collected December 3–30, 2025 (27 days).

The full dataset is available on Mendeley Data:  
📊 **[Data for: Attention Dynamics in Online Communities](https://data.mendeley.com/datasets/XXXXX)** *(link pending)*

Contents:
- `items.csv` — All HN content with AI-enriched metadata (topic, sentiment)
- `item_snapshots.csv` — Time-series score/comment observations
- `analysis_results.json` — Pre-computed statistics
- `README.md` — Data documentation

## Project Structure

```
hn-analyzer/
├── analysis/                 # Python analysis scripts
│   ├── hn_behavioral_analysis.py         # Core analysis
│   ├── hn_behavioral_analysis_enhanced.py # With Clauset power-law methodology
│   ├── hn_deep_analysis.py               # Deep dive analysis
│   ├── hn_viral_analysis.py              # Viral content analysis
│   └── figures/                          # Generated figures + results JSON
├── paper/                    # Academic paper
│   ├── hn_behavioral_paper.tex           # LaTeX source
│   ├── hn_behavioral_paper.pdf           # Compiled PDF
│   └── figures/                          # Paper figures (PNG + PDF)
└── data/                     # Data documentation (files via Mendeley)
    └── README.md
```

## Requirements

```bash
pip install pandas numpy scipy matplotlib seaborn powerlaw
```

## Usage

```bash
# Download data from Mendeley and place in data/
cd analysis
python hn_behavioral_analysis_enhanced.py
```

This generates all figures to `figures/` and outputs `analysis_results.json`.

## Data Collection

Data collected using the companion archiving system: **[hn-archiver](https://github.com/philippdubach/hn-archiver)**

Snapshot strategy prioritizes high-engagement content:
- Score spikes (≥20 point increase)
- Front-page appearances  
- Periodic sampling (every 4th update)
- Initial discovery

## Citation

```bibtex
@article{dubach2025attention,
  title={Attention Dynamics in Online Communities: Power Laws, Preferential 
         Attachment, and Early Success Prediction on Hacker News},
  author={Dubach, Philipp D.},
  year={2025},
  note={Available at: https://github.com/philippdubach/hn-analyzer}
}
```

## License

MIT License

## Author

**Philipp D. Dubach**  
Zurich, Switzerland  
phdubach@pm.me
