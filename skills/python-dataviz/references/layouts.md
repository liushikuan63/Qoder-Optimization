# Multi-Panel Layouts

多子图布局：matplotlib 用 `subplots`，seaborn 用 `FacetGrid`，plotly 用 `make_subplots`。

## matplotlib Grid

```python
import matplotlib.pyplot as plt

fig, axes = plt.subplots(2, 2, figsize=(12, 9), constrained_layout=True)
axes[0, 0].plot(x, y)
axes[0, 1].bar(cats, vals)
axes[1, 0].hist(data, bins=30)
axes[1, 1].scatter(x2, y2)
fig.suptitle('Overview')
```

- 用 `constrained_layout=True` 代替 `tight_layout()`，自动处理标题与轴标签重叠。
- 共享轴：`sharex=True, sharey=True`（同量纲对比时减少重复刻度）。

## seaborn FacetGrid / pairplot

```python
import seaborn as sns

g = sns.FacetGrid(df, col='category', row='region', height=3.5, aspect=1.2)
g.map_dataframe(sns.scatterplot, x='x', y='y')
g.set_axis_labels('X', 'Y')
g.figure.suptitle('By Category and Region', y=1.02)
```

## plotly make_subplots

```python
from plotly.subplots import make_subplots
import plotly.graph_objects as go

fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                    subplot_titles=('Trend', 'Residual'))
fig.add_trace(go.Scatter(x=dates, y=values, name='value'), row=1, col=1)
fig.add_trace(go.Bar(x=dates, y=residual, name='residual'), row=2, col=1)
fig.update_layout(template='plotly_white', height=600)
```

## 对齐与尺寸

- 子图数量 > 4 时，行优先排布并固定 `height ≈ 3 × rows` 英寸，避免每格过扁。
- 混合量纲（如计数 + 百分比）不要共用 y 轴；用 `secondary_y`（pandas）或单独一行子图。
- 图例统一放 figure 级（`fig.legend(...)` / `fig.update_layout(legend=...)`），不要每格各放一个。
