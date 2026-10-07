/*!
 * Rastreamento de cliques, leads e origem (gclid, UTM, palavra-chave) — LP de consórcio.
 * Mesmo método do rastreio ZRO: origem persistida por 90 dias, ValueTrack do Google Ads,
 * e janela pedindo o WhatsApp antes de abrir a conversa (é o telefone que casa a venda
 * com o clique mais tarde).
 */
(function () {
  'use strict';

  // ======================= CONFIGURAÇÃO =======================
  var CONFIG = {
    // WhatsApp de destino (DDI+DDD+número, só dígitos).
    WHATSAPP: '5511984083985',

    // Endpoint que grava no banco. '' desliga o envio.
    ENDPOINT: 'cs-track.php',

    // Janela pedindo o WhatsApp antes de abrir a conversa:
    //  'all' = sempre | 'paid' = só quem veio de anúncio | 'off' = nunca
    // Quem já informou o telefone neste navegador não digita de novo.
    PHONE_GATE: 'all',
    ALLOW_SKIP: false,       // mostrar "Pular e abrir o WhatsApp"
    PEDIR_NOME: true,

    // Google Ads (opcional): copie do snippet da conversão.
    GOOGLE_ADS_ID: '',               // ex: 'AW-XXXXXXXXX'
    GOOGLE_ADS_LABEL_LEAD: '',       // ex: 'abcDEF123'

    ATTRIBUTION_DAYS: 90             // validade do gclid no Google Ads
  };
  // ============================================================

  var CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'];
  var UTMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var VALUETRACK = ['keyword', 'matchtype', 'network', 'device', 'placement', 'campaignid',
    'adgroupid', 'creative', 'targetid', 'loc_physical_ms'];
  var TRACKED = CLICK_IDS.concat(UTMS, VALUETRACK);
  var DAY = 864e5;
  var SESSION_MS = 30 * 60 * 1000;

  // ---------- storage seguro (modo privado não quebra nada) ----------
  var mem = {};
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function getJSON(k) { try { return JSON.parse(get(k) || 'null'); } catch (e) { return null; } }
  function setJSON(k, v) { set(k, JSON.stringify(v)); }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }

  // ---------- visitante e sessão ----------
  var now = Date.now();
  var visitorId = get('cs_vid');
  if (!visitorId) { visitorId = uid(); set('cs_vid', visitorId); }
  var visitNumber = parseInt(get('cs_visits'), 10) || 0;
  var sessionId = get('cs_sid');
  if (!sessionId || now - (parseInt(get('cs_sid_ts'), 10) || 0) > SESSION_MS) {
    sessionId = uid();
    set('cs_sid', sessionId);
    visitNumber += 1;
    set('cs_visits', String(visitNumber));
  }
  function touchSession() { set('cs_sid_ts', String(Date.now())); }
  touchSession();

  // ---------- origem: first touch, last touch e último clique Google ----------
  function valid(t) { return !!(t && t.ts && Date.now() - t.ts < CONFIG.ATTRIBUTION_DAYS * DAY); }

  var urlParams = (function () {
    var p = new URLSearchParams(location.search), out = null;
    TRACKED.forEach(function (k) {
      var v = p.get(k);
      if (v) { out = out || {}; out[k] = v.slice(0, 255); }
    });
    return out;
  })();

  if (urlParams) {
    var touch = assign({
      ts: now,
      landing_url: location.href.slice(0, 1000),
      referrer: document.referrer.slice(0, 1000)
    }, urlParams);
    if (!valid(getJSON('cs_ft'))) setJSON('cs_ft', touch);
    setJSON('cs_lt', touch);
    // gclid separado: uma visita posterior só com UTM não apaga o clique do Google
    if (urlParams.gclid || urlParams.gbraid || urlParams.wbraid) {
      setJSON('cs_gc', {
        ts: now,
        gclid: urlParams.gclid || '',
        gbraid: urlParams.gbraid || '',
        wbraid: urlParams.wbraid || ''
      });
    }
  }

  function attribution() {
    var ft = getJSON('cs_ft');
    var lt = getJSON('cs_lt');
    var gc = getJSON('cs_gc');
    var out = {};
    // last touch manda, first touch preenche o que faltar
    [valid(ft) ? ft : null, valid(lt) ? lt : null].forEach(function (t) {
      if (!t) return;
      TRACKED.forEach(function (k) { if (t[k]) out[k] = t[k]; });
    });
    // o clique do Google sobrepõe: é ele que o upload de conversão precisa
    if (valid(gc)) {
      if (gc.gclid) out.gclid = gc.gclid;
      if (gc.gbraid) out.gbraid = gc.gbraid;
      if (gc.wbraid) out.wbraid = gc.wbraid;
    }
    if (valid(ft)) {
      out.landing_url = ft.landing_url;
      out.first_touch = ft;
    }
    return out;
  }

  function veioDeAnuncio() {
    var a = attribution();
    return !!(a.gclid || a.gbraid || a.wbraid || a.msclkid || a.fbclid ||
      (a.utm_medium && /cpc|ppc|paid/i.test(a.utm_medium)));
  }

  // ---------- envio ----------
  function deviceType() {
    var w = window.innerWidth || 0;
    return w < 768 ? 'mobile' : (w < 1100 ? 'tablet' : 'desktop');
  }

  function send(event, data, cb) {
    touchSession();
    if (!CONFIG.ENDPOINT) { if (cb) cb(); return; }
    var body = JSON.stringify({
      event: event,
      data: data || {},
      attribution: attribution(),
      visitor_id: visitorId,
      session_id: sessionId,
      visit_number: visitNumber,
      page_url: location.href.slice(0, 1000),
      referrer: document.referrer.slice(0, 1000),
      device_type: deviceType(),
      lang: navigator.language,
      tz: Intl && Intl.DateTimeFormat ? Intl.DateTimeFormat().resolvedOptions().timeZone : '',
      screen: screen.width + 'x' + screen.height,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      client_ts: new Date().toISOString()
    });

    // Sem callback: beacon serve (não segura a navegação).
    if (!cb && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(CONFIG.ENDPOINT, new Blob([body], { type: 'application/json' }));
        return;
      } catch (e) { /* cai no fetch */ }
    }
    var p = fetch(CONFIG.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .catch(function () { return {}; });
    if (cb) {
      // Nunca deixa o visitante preso: 2,5s e segue para o WhatsApp de qualquer jeito.
      var feito = false;
      var fim = function (res) { if (!feito) { feito = true; cb(res || {}); } };
      p.then(fim);
      setTimeout(fim, 2500);
    }
  }

  function gtagLead() {
    if (!CONFIG.GOOGLE_ADS_ID || !CONFIG.GOOGLE_ADS_LABEL_LEAD || !window.gtag) return;
    try {
      window.gtag('event', 'conversion', {
        send_to: CONFIG.GOOGLE_ADS_ID + '/' + CONFIG.GOOGLE_ADS_LABEL_LEAD
      });
    } catch (e) { /* ignora */ }
  }

  // ---------- telefone ----------
  function normalizaFone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if ((d.length === 12 || d.length === 13) && d.indexOf('55') === 0) d = d.slice(2);
    if (d.length !== 10 && d.length !== 11) return null;
    return '55' + d;
  }
  function mascara(v) {
    var d = String(v).replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
    if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
  }

  // ---------- janela de telefone ----------
  var CSS = '.csm{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(0,0,0,.55);padding:20px;font-family:inherit}'
    + '.csm-box{background:#fff;border-radius:16px;padding:26px 24px;max-width:380px;width:100%;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.3);position:relative}'
    + '.csm-x{position:absolute;top:10px;right:14px;border:0;background:none;font-size:24px;line-height:1;'
    + 'color:#999;cursor:pointer}'
    + '.csm h3{margin:0 0 6px;font-size:18px;color:#1F1F1F}'
    + '.csm p{margin:0 0 16px;font-size:13.5px;color:#666;line-height:1.5}'
    + '.csm label{display:block;font-size:12px;color:#666;margin:0 0 5px}'
    + '.csm input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #ddd;border-radius:9px;'
    + 'font-size:16px;margin-bottom:12px}'
    + '.csm input:focus{outline:none;border-color:#EE3124}'
    + '.csm-go{width:100%;padding:14px;border:0;border-radius:999px;background:#25D366;color:#fff;'
    + 'font-size:15px;font-weight:600;cursor:pointer}'
    + '.csm-go[disabled]{opacity:.6;cursor:default}'
    + '.csm-skip{display:block;width:100%;margin-top:10px;background:none;border:0;color:#888;'
    + 'font-size:13px;cursor:pointer;text-decoration:underline}'
    + '.csm-err{color:#c00;font-size:12.5px;margin:-6px 0 10px}'
    + '.csm-hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}';

  var modalAberto = false;

  function abrirWhats(ctx) {
    var msg = ctx && ctx.mensagem ? ctx.mensagem
      : 'Olá! Vim pela página e quero saber mais sobre o consórcio.';
    var url = 'https://wa.me/' + CONFIG.WHATSAPP + '?text=' + encodeURIComponent(msg);
    window.open(url, '_blank');
  }

  function pedirTelefone(ctx) {
    if (modalAberto) return;
    modalAberto = true;
    send('lead_modal_open', { cta: ctx.cta });

    var wrap = document.createElement('div');
    wrap.className = 'csm';
    wrap.innerHTML =
      '<div class="csm-box" role="dialog" aria-modal="true" aria-label="Seus dados">'
      + '<button class="csm-x" aria-label="Fechar">&times;</button>'
      + '<h3>Quase lá!</h3>'
      + '<p>Deixe seu WhatsApp para o consultor retomar a conversa caso ela caia.</p>'
      + (CONFIG.PEDIR_NOME
        ? '<label for="csm-nome">Seu nome</label><input id="csm-nome" autocomplete="name" placeholder="Como podemos te chamar?">'
        : '')
      + '<label for="csm-fone">WhatsApp</label>'
      + '<input id="csm-fone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="(11) 99999-9999">'
      + '<input class="csm-hp" tabindex="-1" aria-hidden="true" id="csm-hp" autocomplete="off">'
      + '<div class="csm-err" id="csm-err" hidden></div>'
      + '<button class="csm-go" id="csm-go">Abrir o WhatsApp</button>'
      + (CONFIG.ALLOW_SKIP ? '<button class="csm-skip" id="csm-skip">Pular e abrir o WhatsApp</button>' : '')
      + '</div>';
    document.body.appendChild(wrap);

    var fone = wrap.querySelector('#csm-fone');
    var nome = wrap.querySelector('#csm-nome');
    var err = wrap.querySelector('#csm-err');
    var go = wrap.querySelector('#csm-go');
    setTimeout(function () { (nome || fone).focus(); }, 50);

    fone.addEventListener('input', function () { fone.value = mascara(fone.value); });

    function fechar(motivo) {
      if (!wrap.parentNode) return;
      wrap.parentNode.removeChild(wrap);
      modalAberto = false;
      if (motivo) send('lead_modal_close', { motivo: motivo, cta: ctx.cta });
    }
    wrap.querySelector('.csm-x').addEventListener('click', function () { fechar('x'); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) fechar('fora'); });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' && modalAberto) { fechar('esc'); document.removeEventListener('keydown', esc); }
    });

    var pular = wrap.querySelector('#csm-skip');
    if (pular) pular.addEventListener('click', function () {
      send('lead_skip', { cta: ctx.cta });
      fechar(null);
      abrirWhats(ctx);
    });

    function enviar() {
      var tel = normalizaFone(fone.value);
      if (!tel) {
        err.textContent = 'Confira o número: faltou DDD ou algum dígito.';
        err.hidden = false;
        fone.focus();
        send('lead_invalid', { cta: ctx.cta });
        return;
      }
      err.hidden = true;
      go.disabled = true;
      go.textContent = 'Abrindo…';
      set('cs_fone', tel);
      if (nome && nome.value.trim()) set('cs_nome', nome.value.trim().slice(0, 120));

      send('lead_submit', assign({
        phone: tel,
        nome: nome ? nome.value.trim() : '',
        hp: wrap.querySelector('#csm-hp').value,
        whatsapp_destino: CONFIG.WHATSAPP,
        cta: ctx.cta
      }, ctx.dados || {}), function () {
        gtagLead();
        fechar(null);
        abrirWhats(ctx);
      });
    }
    go.addEventListener('click', enviar);
    fone.addEventListener('keydown', function (e) { if (e.key === 'Enter') enviar(); });
  }

  // Ponto de entrada único: a LP chama isto em vez de abrir o WhatsApp direto.
  function irParaWhatsApp(ctx) {
    ctx = ctx || {};
    var jaTem = get('cs_fone');
    var precisa = CONFIG.PHONE_GATE === 'all'
      || (CONFIG.PHONE_GATE === 'paid' && veioDeAnuncio());

    if (!precisa || jaTem) {
      // Já conhecemos o telefone: registra o lead de novo (nova intenção) e segue.
      send(jaTem ? 'lead_submit' : 'whatsapp_click', assign({
        phone: jaTem || '',
        nome: get('cs_nome') || '',
        whatsapp_destino: CONFIG.WHATSAPP,
        cta: ctx.cta
      }, ctx.dados || {}), function () { abrirWhats(ctx); });
      return;
    }
    pedirTelefone(ctx);
  }

  // ---------- eventos automáticos da página ----------
  var estilo = document.createElement('style');
  estilo.textContent = CSS;
  document.head.appendChild(estilo);

  send('page_view', {});

  var marcos = [25, 50, 75, 100];
  var vistos = {};
  window.addEventListener('scroll', function () {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    if (h <= 0) return;
    var pct = Math.round((window.scrollY / h) * 100);
    marcos.forEach(function (m) {
      if (pct >= m && !vistos[m]) { vistos[m] = true; send('scroll_depth', { profundidade: m }); }
    });
  }, { passive: true });

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) send('phone_click', { destino: href.slice(4) });
    else if (/^mailto:/i.test(href)) send('email_click', { destino: href.slice(7) });
  }, true);

  window.addEventListener('pagehide', function () { send('page_exit', {}); });

  // ---------- API pública ----------
  window.CSTrack = {
    send: send,
    whatsapp: irParaWhatsApp,
    attribution: attribution,
    veioDeAnuncio: veioDeAnuncio,
    telefoneConhecido: function () { return get('cs_fone'); },
    config: CONFIG
  };
})();
