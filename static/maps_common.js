/* Shared Google Maps loader for OrderFood. Pages set window.OF_MAPS_CONFIG = {key, mapId, region}.
   OFMaps.load() resolves with the Maps libraries, or rejects (no key / bad key / offline) so every
   page can fall back to a plain, map-less layout. */
(function () {
    var cfg = window.OF_MAPS_CONFIG || {};
    var loading = null;

    function load() {
        if (loading) return loading;
        loading = new Promise(function (resolve, reject) {
            if (!cfg.key) { reject(new Error('no-key')); return; }
            window.gm_authFailure = function () {            // key rejected / API not enabled for this key
                document.dispatchEvent(new CustomEvent('of-maps-auth-failed'));
                reject(new Error('auth'));
            };
            window.__ofMapsReady = function () {
                var names = ['maps', 'marker', 'places', 'geocoding', 'core'];
                Promise.all(names.map(function (n) { return google.maps.importLibrary(n); }))
                    .then(function (libs) {
                        var out = {};
                        names.forEach(function (n, i) { out[n] = libs[i]; });
                        resolve(out);
                    }).catch(reject);
            };
            var s = document.createElement('script');
            s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.key) +
                    '&v=weekly&loading=async&libraries=places,marker,geocoding&callback=__ofMapsReady';
            s.async = true;
            s.onerror = function () { reject(new Error('load-failed')); };
            document.head.appendChild(s);
        });
        return loading;
    }

    var PIN_LABELS = { restaurant: 'R', agent: 'A', home: 'D' };
    function pin(kind, title) {
        var el = document.createElement('div');
        el.className = 'of-pin of-pin-' + kind;
        el.textContent = PIN_LABELS[kind] || '?';
        if (title) el.title = title;
        return el;
    }

    function haversine(a, b) {                                   // metres between [lat, lon] pairs
        var R = 6371000, rad = Math.PI / 180;
        var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
        var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    function latLng(p) {                                         // LatLng | {lat,lng} -> {lat, lng}
        return { lat: typeof p.lat === 'function' ? p.lat() : p.lat, lng: typeof p.lng === 'function' ? p.lng() : p.lng };
    }

    window.OFMaps = { cfg: cfg, load: load, pin: pin, haversine: haversine, latLng: latLng };
})();
