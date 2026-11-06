# Plotly Interactive Charts

Plotly 版本选择：`plotly.express` 适合常规图表（一行出图），`plotly.graph_objects` 适合精细控制。模板统一用 `plotly_white`。

## Scatter / Line

```python
import plotly.express as px

# Scatter：按类着色 + hover 附加字段
fig = px.scatter(df, x='x', y='y', color='group', hover_data=['label'],
                 title='Scatter', template='plotly_white')
fig.update_traces(marker=dict(size=10, opacity=0.7, line=dict(width=1, color='white')))

# Line：多序列
fig = px.line(df, x='date', y='value', color='series', template='plotly_white')
```

## Bar / Grouped Bar

```python
fig = px.bar(df, x='category', y='value', color='group', barmode='group',
             template='plotly_white')
fig.update_layout(yaxis_title='Value', xaxis_title='')
```

## Heatmap / Correlation

```python
fig = px.imshow(df.corr(), text_auto='.2f', color_continuous_scale='RdBu_r',
                zmin=-1, zmax=1, template='plotly_white')
```

## 导出

```python
fig.write_html('chart.html')     # 交互页（自包含）
fig.write_image('chart.png')     # 静态图，需要 kaleido
fig.show()                       # notebook / 本地打开
```

## 常见坑

- `write_image` 报错 `kaleido` 缺失：`pip install -U kaleido`；仍报错时改用 `write_html`。
- 中文字体：`fig.update_layout(font=dict(family='Microsoft YaHei'))`，否则中文显示方框。
- 大数据量（>10 万点）：改用 `px.scatter(..., render_mode='webgl')` 或先聚合。

可直接运行的完整示例见 `scripts/interactive.py`。
