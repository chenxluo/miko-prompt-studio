"""Render a self-contained, distributable HTML visualization for a run.

The output is a single ``.html`` file with all data (including input images
as base64 data URIs) inlined, so it can be emailed or archived and opened in
any browser without a server. The page degrades gracefully: the card grid is
server-rendered (text + status visible with JS disabled); images and the
detail overlay are progressively enhanced by a small inline script.

Images are stored exactly once — in the embedded JSON payload — and injected
into card thumbnails by JS. Inlining the first image again per card would
roughly double the bytes of a multi-hundred-item batch, which is the case
that matters most for this export.
"""

from __future__ import annotations

import base64
import html
import json
from pathlib import Path
from typing import Any

_MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def _local_image_path(image: dict[str, Any]) -> Path | None:
    """Return a readable local file path for the image, if one exists.

    Mirrors app.services.image_persist._resolve_source_path but kept local so
    this module does not reach into another module's private API.
    """
    resolved = image.get("resolved") or {}
    value = resolved.get("path")
    if isinstance(value, str):
        path = Path(value)
        if path.is_file():
            return path
    value = image.get("path")
    if isinstance(value, str):
        path = Path(value)
        if path.is_file():
            return path
    return None


def _image_to_src(image: dict[str, Any]) -> str | None:
    """Resolve an image dict to a browser-renderable src, inlining when possible.

    Priority: existing data URI > local file (base64) > remote http(s) URL >
    None (no preview available).
    """
    resolved = image.get("resolved") or {}
    uri = resolved.get("uri") or image.get("uri")
    if isinstance(uri, str):
        if uri.startswith("data:"):
            return uri
        if uri.startswith("http://") or uri.startswith("https://"):
            # Remote: keep the link rather than fetch at export time. Renders
            # only when the viewer is online, but avoids blocking export.
            return uri
    local = _local_image_path(image)
    if local is not None:
        mime = (
            resolved.get("mime_type")
            or image.get("mime_type")
            or _MIME_BY_EXT.get(local.suffix.lower(), "image/png")
        )
        try:
            encoded = base64.b64encode(local.read_bytes()).decode("ascii")
        except OSError:
            return None
        return f"data:{mime};base64,{encoded}"
    return None


def _image_view(image: dict[str, Any]) -> dict[str, Any]:
    resolved = image.get("resolved") or {}
    return {
        "src": _image_to_src(image),
        "role": image.get("role"),
        "order": image.get("order") or 0,
        "display_name": image.get("display_name") or resolved.get("display_name"),
    }


def _extract_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)


def _serialize_item(item_data: dict[str, Any]) -> dict[str, Any]:
    """Project a run-item dict (from _run_item_to_dict) into the view model."""
    req_snap = item_data.get("internal_request_snapshot") or {}
    images_in = req_snap.get("images") or []
    prompt_spec = req_snap.get("prompt") or {}
    render_ctx = prompt_spec.get("render_context") or {}
    response = item_data.get("response") or {}

    images = [_image_view(img) for img in images_in if isinstance(img, dict)]
    images.sort(key=lambda im: im.get("order") or 0)

    raw_text = _extract_text(response.get("raw_text"))
    parsed = response.get("parsed")
    reasoning_text = _extract_text(response.get("reasoning_text"))

    preview_source = raw_text
    if not preview_source and parsed is not None:
        preview_source = parsed if isinstance(parsed, str) else json.dumps(
            parsed, ensure_ascii=False
        )

    return {
        "run_item_id": item_data.get("run_item_id"),
        "sample_id": item_data.get("sample_id"),
        "status": item_data.get("status") or "unknown",
        "model_id": item_data.get("model_id"),
        "provider_id": item_data.get("provider_id"),
        "images": images,
        "vars": render_ctx.get("vars") or {},
        "system_prompt": prompt_spec.get("system_prompt"),
        "user_prompt": prompt_spec.get("user_prompt"),
        "response": {
            "raw_text": raw_text,
            "parsed": parsed,
            "reasoning_text": reasoning_text,
        },
        "usage": item_data.get("usage") or {},
        "cost": item_data.get("cost") or {},
        "estimated_cost": item_data.get("estimated_cost"),
        "review": item_data.get("review") or {},
        "error": item_data.get("error"),
        "latency_ms": item_data.get("latency_ms"),
        "created_at": item_data.get("created_at"),
        "preview": preview_source.strip(),
    }


def _summary(items: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(items)
    succeeded = sum(1 for it in items if it["status"] == "succeeded")
    failed = sum(1 for it in items if it["status"] == "failed")
    latencies = [it["latency_ms"] for it in items if isinstance(it["latency_ms"], (int, float))]
    avg_latency = round(sum(latencies) / len(latencies), 1) if latencies else None
    return {
        "total": total,
        "succeeded": succeeded,
        "failed": failed,
        "avg_latency_ms": avg_latency,
    }


def _render_cards(items: list[dict[str, Any]]) -> str:
    """Server-render the card grid structure. Thumbnails are filled by JS."""
    cards: list[str] = []
    for idx, it in enumerate(items):
        status = html.escape(it["status"])
        sample = html.escape(it["sample_id"] or "")
        preview = html.escape(it["preview"] or "")
        review = it["review"] or {}
        rating = review.get("rating")
        accepted = review.get("accepted")
        badges: list[str] = [f'<span class="badge status-{status}">{status}</span>']
        if accepted is True:
            badges.append('<span class="badge accept">✓</span>')
        elif accepted is False:
            badges.append('<span class="badge reject">✕</span>')
        if rating:
            badges.append(f'<span class="badge rating">★ {html.escape(str(rating))}</span>')
        cards.append(
            (
                '<article class="card" data-idx="{idx}" data-status="{status}"'
                ' data-sample="{sample}">'
                '<div class="thumb" data-idx="{idx}"></div>'
                '<div class="card-body">'
                "<p>{preview}</p>"
                '<div class="card-foot">'
                '<span class="mono">{sample}</span>'
                '<span class="badges">{badges}</span>'
                "</div>"
                "</div>"
                "</article>"
            ).format(
                idx=idx,
                status=status,
                sample=sample,
                preview=preview or "—",
                badges="".join(badges),
            )
        )
    return "\n".join(cards)


def _render_stat_row(summary: dict[str, Any], session: dict[str, Any]) -> str:
    avg = summary["avg_latency_ms"]
    avg_text = f"{avg:g} ms" if avg is not None and avg < 1000 else (
        f"{avg / 1000:.2f} s" if avg is not None else "—"
    )
    name = html.escape(session.get("name") or session.get("run_id") or "")
    run_type = html.escape(session.get("run_type") or "")
    model = ""
    config = session.get("config_snapshot") or {}
    model_cfg = config.get("model_config_snapshot") if isinstance(config, dict) else None
    if isinstance(model_cfg, dict) and model_cfg.get("model_id"):
        model = html.escape(str(model_cfg["model_id"]))
    return (
        '<div class="stats">'
        f'<span><label>Run</label><b>{name}</b></span>'
        f'<span><label>Type</label><b>{run_type}</b></span>'
        f'<span><label>Total</label><b>{summary["total"]}</b></span>'
        f'<span><label>OK</label><b class="ok">{summary["succeeded"]}</b></span>'
        f'<span><label>Fail</label><b class="fail">{summary["failed"]}</b></span>'
        f'<span><label>Avg</label><b class="mono">{avg_text}</b></span>'
        f"</div>"
        + (f'<div class="model-line">Model: <span class="mono">{model}</span></div>' if model else "")
    )


_CSS = """
*{box-sizing:border-box}
body{margin:0;background:#0a0a0b;color:#e8e8ea;font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
a{color:#a5b4fc}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header.bar{position:sticky;top:0;z-index:5;background:rgba(15,15,18,.92);backdrop-filter:blur(8px);border-bottom:1px solid #232328;padding:12px 20px}
header.bar h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9a9aa3}
header.bar .sub{margin-top:2px;font-size:11px;color:#6b6b74}
.stats{display:flex;flex-wrap:wrap;gap:18px;margin-top:10px;font-size:12px}
.stats label{display:block;color:#6b6b74;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
.stats b{font-size:14px;font-weight:600}
.stats .ok{color:#34d399}.stats .fail{color:#f87171}
.model-line{margin-top:8px;font-size:11px;color:#9a9aa3}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
.seg{display:inline-flex;border:1px solid #2a2a30;border-radius:6px;overflow:hidden}
.seg button{background:#141416;color:#9a9aa3;border:0;padding:6px 12px;font-size:12px;cursor:pointer}
.seg button.active{background:#6366f1;color:#fff}
.toolbar input[type=search]{flex:1;min-width:160px;background:#141416;border:1px solid #2a2a30;color:#e8e8ea;border-radius:6px;padding:6px 10px;font-size:12px}
.toolbar input[type=search]:focus{outline:0;border-color:#6366f1}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;padding:16px 20px 60px}
.card{background:#141416;border:1px solid #2a2a30;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .12s}
.card:hover{border-color:#6366f1}
.card.hidden{display:none}
.thumb{height:200px;background:#0a0a0b;display:flex;align-items:center;justify-content:center;color:#4a4a52;font-size:11px}
.thumb img{width:100%;height:100%;object-fit:contain;background:#0a0a0b}
.card-body{padding:10px}
.card-body p{margin:0 0 8px;font-size:12px;color:#9a9aa3;max-height:170px;overflow-y:auto;white-space:pre-wrap;word-break:break-word}
.card-foot{display:flex;justify-content:space-between;align-items:center;gap:6px;border-top:1px solid #1f1f23;padding-top:6px}
.card-foot .mono{font-size:10px;color:#6b6b74;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:inline-flex;gap:4px}
.badge{font-size:9px;font-weight:600;padding:2px 6px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em}
.badge.status-succeeded{background:rgba(52,211,153,.15);color:#34d399}
.badge.status-failed{background:rgba(248,113,113,.15);color:#f87171}
.badge.status-running{background:rgba(250,204,21,.15);color:#fbbf24}
.badge.accept{background:rgba(52,211,153,.2);color:#34d399}
.badge.reject{background:rgba(248,113,113,.2);color:#f87171}
.badge.rating{background:rgba(250,204,21,.15);color:#fbbf24}
.empty{padding:60px 20px;text-align:center;color:#6b6b74}
.overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;padding:24px}
.overlay.open{display:flex}
.overlay-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #232328;background:rgba(15,15,18,.8)}
.overlay-bar .left{display:flex;gap:10px;align-items:center;font-size:13px}
.overlay-bar .pos{font-size:11px;color:#6b6b74}
.overlay-bar button{background:transparent;border:0;color:#9a9aa3;cursor:pointer;padding:6px;border-radius:4px}
.overlay-bar button:hover{background:#1f1f23;color:#e8e8ea}
.overlay-body{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.split{display:flex;flex:1;min-height:0;flex-direction:column}
@media(min-width:820px){.split{flex-direction:row}}
.pane{padding:16px;overflow:auto;min-height:0}
.pane.left{flex:0 0 42%;border-bottom:1px solid #232328}
@media(min-width:820px){.pane.left{border-bottom:0;border-right:1px solid #232328}}
.pane.right{flex:1}
.main-img{display:flex;align-items:center;justify-content:center;background:#0a0a0b;border:1px solid #1f1f23;border-radius:8px;min-height:200px;max-height:50vh;margin-bottom:12px}
.main-img img{max-width:100%;max-height:50vh;object-fit:contain;border-radius:6px}
.main-img .none{color:#4a4a52;font-size:12px}
.thumbs{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px}
.thumbs button{flex:0 0 auto;width:52px;height:52px;border-radius:6px;overflow:hidden;border:2px solid transparent;background:transparent;padding:0;cursor:pointer}
.thumbs button.active{border-color:#6366f1}
.thumbs img{width:100%;height:100%;object-fit:cover}
.thumbs .empty-slot{display:flex;align-items:center;justify-content:center;color:#4a4a52;font-size:9px}
.role-tag{display:inline-block;font-size:10px;color:#9a9aa3;background:#1f1f23;padding:2px 8px;border-radius:4px;margin-left:8px}
h3.sec{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#9a9aa3}
.vars{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;margin-bottom:16px}
.vars dt{color:#6b6b74}.vars dd{margin:0;color:#e8e8ea;word-break:break-word}
.block{margin-bottom:16px}
.parsed{background:#0a0a0b;border:1px solid #1f1f23;border-radius:6px;padding:12px;font-size:13px;white-space:pre-wrap;word-break:break-word;line-height:1.6}
pre.raw,pre.json{background:#0a0a0b;border:1px solid #1f1f23;border-radius:6px;padding:12px;font:11px/1.5 ui-monospace,monospace;overflow:auto;max-height:300px;white-space:pre-wrap;word-break:break-word;color:#c4c4cc}
details{margin-bottom:12px;border:1px solid #1f1f23;border-radius:6px;background:#0f0f12}
details>summary{cursor:pointer;padding:10px 12px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9a9aa3;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:'▸ ';color:#6b6b74}
details[open]>summary::before{content:'▾ '}
details .inner{padding:0 12px 12px}
.meta{display:grid;grid-template-columns:8rem 1fr;gap:6px 12px;font-size:12px}
.meta dt{color:#6b6b74}.meta dd{margin:0;color:#e8e8ea}
.review-box{font-size:12px;color:#c4c4cc}
.review-box .row{margin-bottom:6px}
.review-box label{color:#6b6b74;font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-right:6px}
.notes{background:#0a0a0b;border:1px solid #1f1f23;border-radius:6px;padding:8px 10px;white-space:pre-wrap;word-break:break-word;margin-top:4px}
.pill{display:inline-block;font-size:10px;padding:2px 8px;border-radius:999px;background:#1f1f23;color:#c4c4cc;margin:2px 4px 2px 0}
.modal{background:#0f0f12;border:1px solid #2a2a30;border-radius:10px;width:100%;max-width:1100px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.55)}
.overlay-bar .nav-hint{font-size:10px;color:#4a4a52;margin:0 10px 0 6px;letter-spacing:.06em;white-space:nowrap}
footer.foot{padding:12px 20px;border-top:1px solid #232328;font-size:10px;color:#4a4a52;text-align:center}
"""

_JS = r"""
(function(){
  var DATA = JSON.parse(document.getElementById('run-data').textContent);
  var items = DATA.items;
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var grid = document.getElementById('grid');
  var segButtons = Array.prototype.slice.call(document.querySelectorAll('.seg button'));
  var search = document.getElementById('search');
  var overlay = document.getElementById('overlay');
  var overlayBar = document.getElementById('o-bar');
  var overlayBody = document.getElementById('o-body');
  var currentIdx = -1;

  // Inject thumbnails from the single-source JSON payload.
  cards.forEach(function(card){
    var idx = +card.getAttribute('data-idx');
    var item = items[idx];
    var slot = card.querySelector('.thumb');
    var first = (item.images && item.images[0]) || null;
    if(slot && first && first.src){
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = first.src;
      slot.innerHTML = '';
      slot.appendChild(img);
    }
  });

  function applyFilter(){
    var status = document.querySelector('.seg button.active').getAttribute('data-filter');
    var q = (search.value || '').trim().toLowerCase();
    cards.forEach(function(card){
      var show = (status === 'all' || card.getAttribute('data-status') === status);
      if(show && q) show = (card.getAttribute('data-sample') || '').toLowerCase().indexOf(q) >= 0;
      card.classList.toggle('hidden', !show);
    });
  }
  segButtons.forEach(function(btn){
    btn.addEventListener('click', function(){
      segButtons.forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      applyFilter();
    });
  });
  search.addEventListener('input', applyFilter);

  function visibleCards(){
    return cards.map(function(c,i){ return i; }).filter(function(i){
      return !cards[i].classList.contains('hidden');
    });
  }

  function esc(s){
    if(s === null || s === undefined) return '';
    return String(s).replace(/[&<>"]/g, function(ch){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch];
    });
  }
  function fmtText(s){ return esc(s).replace(/\n/g,'<br>'); }
  function fmtLatency(ms){
    if(ms === null || ms === undefined || isNaN(ms)) return '—';
    return ms < 1000 ? Math.round(ms)+' ms' : (ms/1000).toFixed(2)+' s';
  }
  function fmtCost(item){
    var cost = item.cost || {};
    var amount = (item.estimated_cost !== undefined && item.estimated_cost !== null)
      ? item.estimated_cost : cost.estimated_cost;
    if(amount === undefined || amount === null) return '—';
    var cur = cost.currency || (DATA.summary && DATA.summary.currency) || 'USD';
    return cur + ' ' + Number(amount).toFixed(6);
  }

  function renderImages(item){
    var imgs = item.images || [];
    if(!imgs.length){
      return '<div class="main-img"><span class="none">No images</span></div>';
    }
    var first = imgs[0];
    var html = '<div class="main-img"><img id="o-mainimg" src="'+esc(first.src||'')+'" alt=""></div>';
    if(imgs.length > 1){
      html += '<div class="thumbs">';
      imgs.forEach(function(im, i){
        var inner = im.src
          ? '<img src="'+esc(im.src)+'" alt="">'
          : '<span class="empty-slot">—</span>';
        html += '<button data-i="'+i+'" class="'+(i===0?'active':'')+'">'+inner+'</button>';
      });
      html += '</div>';
    }
    return html;
  }

  function renderVars(item){
    var v = item.vars || {};
    var keys = Object.keys(v);
    if(!keys.length) return '';
    var rows = keys.map(function(k){
      var val = v[k];
      var text = (typeof val === 'string') ? val : JSON.stringify(val);
      return '<dt>'+esc(k)+'</dt><dd>'+esc(text)+'</dd>';
    }).join('');
    return '<div class="block"><h3 class="sec">Variables</h3><dl class="vars">'+rows+'</dl></div>';
  }

  function renderParsed(item){
    var r = item.response || {};
    var parsed = r.parsed;
    var raw = r.raw_text || '';
    var body = '';
    if(parsed !== null && parsed !== undefined){
      if(typeof parsed === 'string'){
        body = '<div class="parsed">'+fmtText(parsed)+'</div>';
      } else {
        body = '<pre class="json">'+esc(JSON.stringify(parsed, null, 2))+'</pre>';
      }
    } else if(raw){
      body = '<div class="parsed">'+fmtText(raw)+'</div>';
    } else {
      body = '<div class="parsed" style="color:#6b6b74">No output</div>';
    }
    return body;
  }

  function renderDetail(idx){
    var item = items[idx];
    var html = '';
    html += '<div class="split">';
    html += '<div class="pane left">';
    html += '<h3 class="sec">Input</h3>';
    html += renderImages(item);
    html += renderVars(item);
    html += '</div>';
    html += '<div class="pane right">';
    html += '<div class="block"><h3 class="sec">Output</h3>'+renderParsed(item)+'</div>';
    var reasoning = (item.response || {}).reasoning_text;
    if(reasoning){
      html += '<details><summary>Reasoning</summary><div class="inner"><div class="parsed">'+fmtText(reasoning)+'</div></div></details>';
    }
    var raw = (item.response || {}).raw_text;
    if(raw){
      html += '<details><summary>Raw text</summary><div class="inner"><pre class="raw">'+esc(raw)+'</pre></div></details>';
    }
    // Metadata — kept compact per scope decision.
    var u = item.usage || {};
    html += '<details open><summary>Metadata</summary><div class="inner"><dl class="meta">'
      + '<dt>Model</dt><dd>'+esc(item.model_id||'—')+'</dd>'
      + '<dt>Provider</dt><dd>'+esc(item.provider_id||'—')+'</dd>'
      + '<dt>Latency</dt><dd class="mono">'+fmtLatency(item.latency_ms)+'</dd>'
      + '<dt>Tokens</dt><dd class="mono">'+esc((u.input_tokens||'—')+' in / '+(u.output_tokens||'—')+' out')+'</dd>'
      + '<dt>Cost</dt><dd>'+fmtCost(item)+'</dd>'
      + '<dt>Created</dt><dd class="mono">'+esc(item.created_at||'—')+'</dd>'
      + '</dl></div></details>';
    // Prompts.
    if(item.system_prompt || item.user_prompt){
      html += '<details><summary>Prompts</summary><div class="inner">';
      if(item.system_prompt) html += '<h3 class="sec">System</h3><pre class="raw">'+esc(item.system_prompt)+'</pre>';
      if(item.user_prompt) html += '<h3 class="sec">User</h3><pre class="raw">'+esc(item.user_prompt)+'</pre>';
      html += '</div></details>';
    }
    // Review (read-only).
    var rv = item.review || {};
    var hasReview = rv.accepted !== undefined && rv.accepted !== null || rv.rating || rv.notes || (rv.labels && rv.labels.length);
    if(hasReview){
      html += '<details><summary>Review</summary><div class="inner"><div class="review-box">';
      if(rv.accepted === true) html += '<div class="row"><label>Accepted</label>✓ yes</div>';
      if(rv.accepted === false) html += '<div class="row"><label>Accepted</label>✕ no</div>';
      if(rv.rating) html += '<div class="row"><label>Rating</label>★ '+esc(rv.rating)+'</div>';
      if(rv.labels && rv.labels.length) html += '<div class="row"><label>Labels</label>'+rv.labels.map(function(l){return '<span class="pill">'+esc(l)+'</span>';}).join('')+'</div>';
      if(rv.notes) html += '<div class="row"><label>Notes</label><div class="notes">'+esc(rv.notes)+'</div></div>';
      html += '</div></div></details>';
    }
    if(item.error){
      var em = item.error.message || JSON.stringify(item.error);
      html += '<details open><summary>Error</summary><div class="inner"><pre class="raw" style="color:#f87171">'+esc(em)+'</pre></div></details>';
    }
    html += '</div>'; // pane right
    html += '</div>'; // split
    return html;
  }

  function openDetail(idx){
    currentIdx = idx;
    var item = items[idx];
    var vis = visibleCards();
    var pos = vis.indexOf(idx) + 1;
    var total = vis.length;
    overlayBar.innerHTML =
      '<div class="left">'
      + '<span class="badge status-'+esc(item.status)+'">'+esc(item.status)+'</span>'
      + '<span class="mono">'+esc(item.sample_id||'')+'</span>'
      + (item.images && item.images[0] && item.images[0].role ? '<span class="role-tag">'+esc(item.images[0].role)+'</span>' : '')
      + '</div>'
      + '<div class="left"><span class="pos">'+pos+' / '+total+'</span>'
      + '<span class="nav-hint">← → navigate · Esc close</span>'
      + '<button id="o-prev" title="Previous (←)">‹</button>'
      + '<button id="o-next" title="Next (→)">›</button>'
      + '<button id="o-close" title="Close (Esc)">✕</button>'
      + '</div>';
    overlayBody.innerHTML = renderDetail(idx);
    document.getElementById('o-close').addEventListener('click', closeDetail);
    document.getElementById('o-prev').addEventListener('click', function(){ step(-1); });
    document.getElementById('o-next').addEventListener('click', function(){ step(1); });
    bindThumbs(item);
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function bindThumbs(item){
    var main = document.getElementById('o-mainimg');
    var btns = Array.prototype.slice.call(document.querySelectorAll('.thumbs button'));
    btns.forEach(function(btn){
      btn.addEventListener('click', function(){
        btns.forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
        var i = +btn.getAttribute('data-i');
        if(main && item.images[i]) main.src = item.images[i].src || '';
      });
    });
  }
  function closeDetail(){
    overlay.classList.remove('open');
    overlayBody.innerHTML = '';
    overlayBar.innerHTML = '';
    currentIdx = -1;
    document.body.style.overflow = '';
  }
  function step(dir){
    var vis = visibleCards();
    if(!vis.length) return;
    var pos = vis.indexOf(currentIdx);
    if(pos < 0){ pos = dir > 0 ? -1 : vis.length; }
    var next = vis[(pos + dir + vis.length) % vis.length];
    openDetail(next);
  }

  cards.forEach(function(card){
    card.addEventListener('click', function(){
      if(card.classList.contains('hidden')) return;
      openDetail(+card.getAttribute('data-idx'));
    });
  });
  overlay.addEventListener('click', function(e){
    // Click the dim backdrop (not the modal contents) to close the detail.
    if(e.target === overlay) closeDetail();
  });
  document.addEventListener('keydown', function(e){
    if(!overlay.classList.contains('open')) return;
    if(e.key === 'Escape') closeDetail();
    else if(e.key === 'ArrowLeft') step(-1);
    else if(e.key === 'ArrowRight') step(1);
  });
})();
"""


def render_run_html(session: dict[str, Any], items: list[dict[str, Any]]) -> str:
    """Render a complete, self-contained HTML document for a run session."""
    view_items = [_serialize_item(it) for it in items]
    summary = _summary(view_items)
    summary["currency"] = ((session.get("summary") or {}).get("currency")) or "USD"

    payload = {
        "run_id": session.get("run_id"),
        "name": session.get("name"),
        "run_type": session.get("run_type"),
        "summary": summary,
        "items": view_items,
    }
    # Embed JSON safely: break any accidental </script> sequence.
    json_blob = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")

    cards_html = _render_cards(view_items)
    stats_html = _render_stat_row(summary, session)
    grid_inner = cards_html if view_items else '<div class="empty">No items in this run.</div>'

    name = html.escape(session.get("name") or session.get("run_id") or "Run")
    run_type = html.escape(session.get("run_type") or "")

    return (
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html.escape(name)} — {run_type} results</title>\n"
        f"<style>{_CSS}</style>\n"
        "</head>\n<body>\n"
        '<header class="bar">\n'
        f"<h1>{name}</h1>\n"
        '<div class="sub">Self-contained export · '
        f'{html.escape(session.get("run_id") or "")} · '
        f'{html.escape(session.get("completed_at") or session.get("started_at") or "")}</div>\n'
        f"{stats_html}\n"
        '<div class="toolbar">\n'
        '<div class="seg">\n'
        '<button data-filter="all" class="active">All</button>\n'
        '<button data-filter="succeeded">OK</button>\n'
        '<button data-filter="failed">Failed</button>\n'
        "</div>\n"
        f'<input id="search" type="search" placeholder="Filter by sample id…">\n'
        "</div>\n"
        "</header>\n"
        f'<div id="grid" class="grid">\n{grid_inner}\n</div>\n'
        '<div id="overlay" class="overlay">\n'
        '<div class="modal">\n'
        '<div id="o-bar" class="overlay-bar"></div>\n'
        '<div id="o-body" class="overlay-body"></div>\n'
        "</div>\n"
        "</div>\n"
        '<footer class="foot">Generated by Miko Lab · open this file in any browser</footer>\n'
        f'<script type="application/json" id="run-data">{json_blob}</script>\n'
        f"<script>{_JS}</script>\n"
        "</body>\n</html>\n"
    )
