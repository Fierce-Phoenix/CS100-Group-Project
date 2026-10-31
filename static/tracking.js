/* Live delivery tracking for customers, restaurants and delivery agents.
   - Everyone polls /api/orders/<id>/tracking every few seconds (text works even without a map).
   - The agent's browser reports its position to /api/agent/location, either from real GPS or from a
     demo simulator that drives along the real Google route (so you can demo without leaving your desk).
   - A "static" mode draws a one-off preview (used on the agent's request page). */
(function () {
    var root = document.getElementById('track-root');
    if (!root) return;
    var role = root.dataset.role, apiUrl = root.dataset.api || '', locUrl = root.dataset.locurl || '', csrf = root.dataset.csrf || '';
    var staticData = null;
    try { staticData = root.dataset.static ? JSON.parse(root.dataset.static) : null; } catch (e) {}
    var POLL_MS = 5000;
    var $ = function (id) { return document.getElementById(id); };
    function text(id, value) { var el = $(id); if (el) el.textContent = value; }

    var S = { g: null, map: null, markers: {}, lines: {}, stage: null, fitted: false, last: null };

    /* ------------------------------------------------------------------ words */
    var STAGES = {
        preparing:     { customer: 'The restaurant is preparing your order', restaurant: 'Waiting for a delivery agent to pick up', agent: 'The order is being prepared' },
        to_restaurant: { customer: 'Your delivery agent is heading to the restaurant', restaurant: 'Delivery agent is on the way to you', agent: 'Head to the restaurant' },
        to_customer:   { customer: 'Your order is on its way to you', restaurant: 'Order picked up and out for delivery', agent: 'Deliver the order to the customer' },
        self:          { customer: 'The restaurant is delivering your order itself', restaurant: 'You are delivering this order yourself', agent: 'Restaurant is self-delivering' },
        done:          { customer: 'This order is complete', restaurant: 'This order is complete', agent: 'This delivery is complete' }
    };
    function ago(s) {
        if (s === null || s === undefined) return 'no location yet';
        if (s < 10) return 'live';
        if (s < 90) return 'updated ' + s + ' s ago';
        return 'updated ' + Math.round(s / 60) + ' min ago';
    }
    function hasCoordinates(p) {
        return p && p.lat !== null && p.lat !== undefined && p.lon !== null && p.lon !== undefined &&
            Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon));
    }
    function mapsLink(p, origin) {
        var url = 'https://www.google.com/maps/dir/?api=1';
        if (hasCoordinates(origin)) url += '&origin=' + encodeURIComponent(origin.lat + ',' + origin.lon);
        var destination = hasCoordinates(p) ? p.lat + ',' + p.lon : (p.address || '');
        return destination ? url + '&destination=' + encodeURIComponent(destination) + '&travelmode=driving' : '';
    }

    /* ------------------------------------------------------------------ text panel */
    function render(d) {
        S.last = d;
        text('t-stage', (STAGES[d.stage] || STAGES.preparing)[role]);
        var eta = role === 'customer' ? d.eta_customer_min : (role === 'restaurant' ? d.eta_stop_min : d.eta_stop_min);
        if (d.stage === 'done') text('t-eta', 'Done');
        else if (eta) text('t-eta', eta + ' min');
        else text('t-eta', '\u2013');
        var sub = [];
        if (role === 'customer' && d.stage !== 'done' && d.eta_customer_min) sub.push('until your order arrives');
        if (role === 'restaurant' && d.stage === 'to_restaurant') sub.push('until the agent reaches you');
        if (role === 'agent' && d.eta_stop_min) sub.push('to your next stop');
        if (d.distance_km) sub.push(d.distance_km + ' km');
        if (d.source === 'estimate') sub.push('approximate');
        text('t-sub', sub.join(' \u00b7 '));
        if (d.agent) {
            text('t-agent', d.agent.name);
            text('t-seen', ago(d.agent.age_s));
        } else {
            text('t-agent', d.stage === 'preparing' ? 'Not assigned yet' : (d.stage === 'done' ? '\u2013' : 'No live agent'));
            text('t-seen', '');
        }
        var lr = $('t-link-rest'), ld = $('t-link-dest');
        var origin = d.agent ? { lat: d.agent.lat, lon: d.agent.lon } : null;
        if (lr && d.restaurant) {
            lr.href = mapsLink(d.restaurant, origin);
            text('t-rest', d.restaurant.name + (d.restaurant.address ? ' \u2014 ' + d.restaurant.address : ''));
            lr.hidden = !lr.href;
        }
        if (ld && d.destination) {
            ld.href = mapsLink(d.destination, origin);
            text('t-dest', d.destination.address || '');
            ld.hidden = !ld.href;
        }
        var nav = $('t-agent-navigation');
        if (nav && role === 'agent') {
            var stop = d.stage === 'to_restaurant' ? d.restaurant :
                (d.stage === 'to_customer' ? d.destination : null);
            var navUrl = stop ? mapsLink(stop, origin) : '';
            if (navUrl) {
                nav.href = navUrl;
                nav.textContent = d.stage === 'to_customer' ? 'Navigate to customer' : 'Navigate to restaurant';
                nav.hidden = false;
            } else {
                nav.hidden = true;
            }
        }
        var fb = $('t-coords');
        if (fb && !S.map) {
            fb.textContent = (hasCoordinates(d.agent) ? 'Agent: ' + Number(d.agent.lat).toFixed(5) + ', ' + Number(d.agent.lon).toFixed(5) + '. ' : '') +
                (hasCoordinates(d.restaurant) ? 'Restaurant: ' + Number(d.restaurant.lat).toFixed(5) + ', ' + Number(d.restaurant.lon).toFixed(5) + '. ' : '') +
                (hasCoordinates(d.destination) ? 'Customer: ' + Number(d.destination.lat).toFixed(5) + ', ' + Number(d.destination.lon).toFixed(5) + '.' : '');
        }
    }

    /* ------------------------------------------------------------------ map */
    function ensureMarker(key, kind, title, pos) {
        var m = S.markers[key];
        if (!m) {
            m = S.markers[key] = new S.g.marker.AdvancedMarkerElement({ map: S.map, position: pos, title: title, content: OFMaps.pin(kind, title) });
        }
        return m;
    }
    function animateTo(marker, to) {                              // glide instead of jumping between polls
        var from = OFMaps.latLng(marker.position), t0 = performance.now(), DUR = 1200;
        if (marker.__raf) cancelAnimationFrame(marker.__raf);
        (function step(now) {
            var k = Math.min(1, (now - t0) / DUR);
            marker.position = { lat: from.lat + (to.lat - from.lat) * k, lng: from.lng + (to.lng - from.lng) * k };
            if (k < 1) marker.__raf = requestAnimationFrame(step);
        })(t0);
    }
    function setLine(key, path, opts) {
        if (S.lines[key]) { S.lines[key].setMap(null); S.lines[key] = null; }
        if (!path || path.length < 2) return;
        S.lines[key] = new S.g.maps.Polyline(Object.assign({
            map: S.map, path: path.map(function (p) { return { lat: p[0], lng: p[1] }; })
        }, opts));
    }
    function draw(d) {
        if (!S.map) return;
        var pts = [];
        if (hasCoordinates(d.restaurant)) { ensureMarker('rest', 'restaurant', d.restaurant.name, { lat: d.restaurant.lat, lng: d.restaurant.lon }); pts.push({ lat: d.restaurant.lat, lng: d.restaurant.lon }); }
        if (hasCoordinates(d.destination)) { ensureMarker('dest', 'home', 'Delivery address', { lat: d.destination.lat, lng: d.destination.lon }); pts.push({ lat: d.destination.lat, lng: d.destination.lon }); }
        if (d.agent) {
            var to = { lat: d.agent.lat, lng: d.agent.lon };
            var m = S.markers.agent;
            if (!m) { ensureMarker('agent', 'agent', d.agent.name, to); } else if (!(sim.timer && role === 'agent')) { animateTo(m, to); }
            pts.push(to);
        } else if (S.markers.agent) { S.markers.agent.map = null; S.markers.agent = null; }
        if (d.path) {
            setLine('main', d.path, { strokeColor: '#1f5c47', strokeOpacity: 0.9, strokeWeight: 5 });
            d.path.forEach(function (p) { pts.push({ lat: p[0], lng: p[1] }); });
        }
        if (d.path_next !== undefined && d.path) {
            setLine('next', d.path_next, { strokeOpacity: 0, strokeWeight: 3, strokeColor: '#6b7a73',
                icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '14px' }] });
        }
        if (!S.fitted && pts.length) { fit(pts); S.fitted = true; }
        S.lastPts = pts.length ? pts : S.lastPts;
    }
    function fit(pts) {
        var b = new S.g.core.LatLngBounds();
        pts.forEach(function (p) { b.extend(p); });
        S.map.fitBounds(b, 60);
    }
    function initMap() {
        var el = $('track-map');
        return OFMaps.load().then(function (g) {
            S.g = g;
            S.map = new g.maps.Map(el, { center: { lat: 19.076, lng: 72.8777 }, zoom: 12, mapId: OFMaps.cfg.mapId,
                mapTypeControl: false, streetViewControl: false, fullscreenControl: true, gestureHandling: 'greedy' });
            var rc = $('t-recenter');
            if (rc) { rc.hidden = false; rc.addEventListener('click', function () { if (S.lastPts) fit(S.lastPts); }); }
        }).catch(function (err) {
            if (el) el.hidden = true;
            var n = $('track-nomap'); if (n) {
                n.hidden = false;
                if (err && err.message === 'auth') n.textContent = 'Google Maps rejected the API key, so the map is hidden. Live status below still updates.';
            }
        });
    }
    document.addEventListener('of-maps-auth-failed', function () {
        var el = $('track-map'); if (el) el.hidden = true;
        var n = $('track-nomap'); if (n) { n.hidden = false; n.textContent = 'Google Maps rejected the API key, so the map is hidden. Live status below still updates.'; }
    });

    /* ------------------------------------------------------------------ polling */
    function poll(withPath) {
        return fetch(apiUrl + (withPath ? '?path=1' : ''), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
            .then(function (d) {
                var stageChanged = S.stage !== null && d.stage !== S.stage;
                S.stage = d.stage;
                if (stageChanged && !d.path) return poll(true);      // new leg: fetch its route once
                render(d);
                draw(d);
                if (d.path && role === 'agent') sim.setPath(d.path);
                if (d.stage === 'done') clearInterval(S.timer);
            }).catch(function () { /* transient: try again next tick */ });
    }

    /* ------------------------------------------------------------------ agent: GPS or simulator */
    var sim = {
        timer: null, path: [], cum: [], dist: 0, total: 0, mult: 5,
        setPath: function (path) {
            this.path = path; this.cum = [0];
            for (var i = 1; i < path.length; i++) this.cum.push(this.cum[i - 1] + OFMaps.haversine(path[i - 1], path[i]));
            this.total = this.cum[this.cum.length - 1] || 0; this.dist = 0;
        },
        pointAt: function (m) {
            var c = this.cum, i = 1;
            while (i < c.length - 1 && c[i] < m) i++;
            var seg = (c[i] - c[i - 1]) || 1, k = Math.max(0, Math.min(1, (m - c[i - 1]) / seg));
            var a = this.path[i - 1], b = this.path[i];
            return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
        },
        tick: function () {
            if (!sim.path.length) return;
            sim.dist = Math.min(sim.total, sim.dist + 11.1 * sim.mult);     // 11.1 m/s = 40 km/h, times the demo speed-up
            var p = sim.pointAt(sim.dist);
            if (S.markers.agent) S.markers.agent.position = { lat: p[0], lng: p[1] };
            report(p[0], p[1]);
            text('ag-status', sim.dist >= sim.total ? 'Simulation reached the stop \u2014 use the buttons to continue.' : 'Simulating drive\u2026');
        }
    };
    var gpsWatch = null, lastPost = 0;
    function report(lat, lon) {
        if (!locUrl) return;
        fetch(locUrl, { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrf }, body: JSON.stringify({ lat: lat, lon: lon }) })
            .catch(function () {});
    }
    function stopSharing() {
        if (sim.timer) { clearInterval(sim.timer); sim.timer = null; }
        if (gpsWatch !== null) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
    }
    function setMode(mode) {
        stopSharing();
        try { localStorage.setItem('of_agent_mode', mode); } catch (e) {}
        if (mode === 'sim') {
            sim.timer = setInterval(sim.tick, 1000);
            text('ag-status', 'Simulating drive\u2026');
        } else if (mode === 'gps') {
            if (!navigator.geolocation) { text('ag-status', 'This browser has no GPS.'); return; }
            text('ag-status', 'Sharing your live location\u2026');
            gpsWatch = navigator.geolocation.watchPosition(function (pos) {
                var now = Date.now();
                if (now - lastPost < 3000) return;
                lastPost = now; report(pos.coords.latitude, pos.coords.longitude);
            }, function () { text('ag-status', 'Location permission denied.'); }, { enableHighAccuracy: true, maximumAge: 2000 });
        } else {
            text('ag-status', 'Not sharing. Customers and the restaurant see your last known position.');
        }
    }
    function initAgentControls() {
        var modeEl = $('ag-mode'), speedEl = $('ag-speed');
        if (!modeEl) return;
        modeEl.addEventListener('change', function () { setMode(modeEl.value); });
        speedEl.addEventListener('change', function () { sim.mult = +speedEl.value; });
        sim.mult = +speedEl.value;
        var saved = null; try { saved = localStorage.getItem('of_agent_mode'); } catch (e) {}
        if (saved && saved !== 'off') { modeEl.value = saved; setMode(saved); } else { setMode('off'); }
    }

    /* ------------------------------------------------------------------ go */
    initMap().then(function () {
        if (staticData) {                                          // one-off preview, no polling
            S.stage = 'static';
            var d = {
                restaurant: staticData.restaurant ? { name: staticData.restaurant.name, lat: staticData.restaurant.lat, lon: staticData.restaurant.lon } : null,
                destination: staticData.destination, agent: staticData.agent,
                path: staticData.path || staticData.path_next, path_next: staticData.path ? staticData.path_next : undefined
            };
            draw(d);
            return;
        }
        initAgentControls();
        poll(true).then(function () { S.timer = setInterval(function () { poll(false); }, POLL_MS); });
    });
})();
