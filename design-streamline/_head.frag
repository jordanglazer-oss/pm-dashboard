<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
  <style>
    body { margin: 0; background: #f6f7f9; color: #10151c;
           font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
           -webkit-font-smoothing: antialiased; }
    a { color: #2d5bd0; text-decoration: none; }
    a:hover { color: #2c43be; }
    .mono { font-family: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
    table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
    .eyebrow { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: #9aa3b0; }
    .card { border: 1px solid #e6e8ec; border-radius: 8px; background: #ffffff; box-shadow: 0 1px 2px rgb(16 21 28 / 0.05); }
    .seg { display: flex; align-items: center; gap: 2px; border-radius: 8px; background: #fafbfc; border: 1px solid #e6e8ec; padding: 2px; width: fit-content; }
    .seg .on { border-radius: 6px; background: #ffffff; box-shadow: 0 1px 2px rgb(16 21 28 / 0.05); padding: 4px 12px; font-size: 13px; font-weight: 600; color: #10151c; }
    .seg .off { padding: 4px 12px; font-size: 13px; color: #5b6472; }
    .th { text-align: left; padding: 8px 10px; font-size: 11px; font-weight: 600; color: #9aa3b0; }
    .thr { text-align: right; padding: 8px 10px; font-size: 11px; font-weight: 600; color: #9aa3b0; }
    .tl { font-size: 10px; color: #9aa3b0; }
    .tv { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums; font-size: 14px; font-weight: 600; color: #10151c; margin-top: 2px; }
    .pill-pos { border-radius: 20px; background: #f0f9f4; color: #12805c; padding: 2px 8px; font-size: 11px; font-weight: 600; }
    .pill-neg { border-radius: 20px; background: #fdf2f3; color: #d1435b; padding: 2px 8px; font-size: 11px; font-weight: 600; }
    .pill-warn { border-radius: 20px; background: #fbf6ea; color: #b8791f; padding: 2px 8px; font-size: 11px; font-weight: 600; }
    .pill-mut { border: 1px solid #e6e8ec; border-radius: 20px; background: #fafbfc; color: #5b6472; padding: 2px 8px; font-size: 11px; font-weight: 600; }
    .btn { border: 1px solid #e6e8ec; border-radius: 8px; background: #ffffff; padding: 5px 11px; font-size: 12px; color: #5b6472; }
    .btn-p { border-radius: 8px; background: #2d5bd0; padding: 5px 11px; font-size: 12px; font-weight: 600; color: #ffffff; }
  </style>
</helmet>
