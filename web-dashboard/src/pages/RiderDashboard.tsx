import { useMemo, useState, useEffect } from 'react';
import { LocationAutocomplete, type LocationValue } from '../components/search/LocationAutocomplete';
import { RouteMap } from '../components/map/RouteMap';
import { useLocation } from '../hooks/useLocation';
import { requestRide, searchMatches, listRequests } from '../services/api';

function isoLocalNowPlus(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

export default function RiderDashboard() {
  const { location } = useLocation();

  const [riderName, setRiderName] = useState('Rider 1');
  const [start, setStart] = useState<LocationValue | null>(null);
  const [end, setEnd] = useState<LocationValue | null>(null);
  const [startTime, setStartTime] = useState(isoLocalNowPlus(35));

  const [matches, setMatches] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [requested, setRequested] = useState<any | null>(null);

  const [myRequests, setMyRequests] = useState<any[]>([]);

  useEffect(() => {
    listRequests().then(setMyRequests).catch(console.error);
  }, []);

  const center = useMemo(() => location ?? start?.lngLat ?? end?.lngLat ?? null, [location, start?.lngLat, end?.lngLat]);
  const canSearch = !!start && !!end;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '460px 1fr', height: '100%' }}>
      <section style={{ padding: 16, borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Rider dashboard</div>

        <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Rider name</label>
            <input
              value={riderName}
              onChange={(e) => setRiderName(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
            />
          </div>
          <LocationAutocomplete
            label="Pickup location"
            value={start}
            onChange={(v) => {
              setStart(v);
              setSelected(null);
              setRequested(null);
            }}
            proximity={center}
          />
          <LocationAutocomplete
            label="Drop location"
            value={end}
            onChange={(v) => {
              setEnd(v);
              setSelected(null);
              setRequested(null);
            }}
            proximity={center}
          />
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Pickup time</label>
            <input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
            />
          </div>

          <button
            disabled={!canSearch || loading}
            onClick={async () => {
              try {
                setLoading(true);
                setErr(null);
                setSelected(null);
                setRequested(null);
                if (!start || !end) return;
                const res = await searchMatches({
                  start: start.lngLat,
                  end: end.lngLat,
                  startPlaceName: start.name,
                  endPlaceName: end.name,
                  startTime: new Date(startTime).toISOString(),
                });
                setMatches(res.matches);
              } catch (e: any) {
                setErr(e?.response?.data?.message ?? e?.message ?? 'Search failed');
              } finally {
                setLoading(false);
              }
            }}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #e5e7eb',
              background: canSearch ? '#111827' : '#9ca3af',
              color: '#fff',
              cursor: canSearch ? 'pointer' : 'not-allowed',
            }}
          >
            Search rides
          </button>

          {err && <div style={{ padding: 12, borderRadius: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>{err}</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Matches</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>{matches.length} found</div>
        </div>

        <div style={{ marginTop: 10 }}>
          {matches.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No matches yet. Try widening time/radius in backend later.</div>}
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelected(m)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: 12,
                borderRadius: 12,
                border: '1px solid #e5e7eb',
                background: selected?.id === m.id ? '#eff6ff' : '#fff',
                cursor: 'pointer',
                marginBottom: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{m.driverName}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>score {Number(m.score).toFixed(2)}</div>
              </div>
              <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                {m.startPlaceName} → {m.endPlaceName}
              </div>
              <div style={{ fontSize: 12, color: '#16a34a', marginTop: 6, fontWeight: 600 }}>
                Estimated Pickup ETA: {new Date(m.estimatedPickupTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                time Δ {Number(m.timeDiffMinutes).toFixed(0)} min · walk {Number(m.startDistanceMeters).toFixed(0)}m
              </div>
            </button>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <button
            disabled={!selected || !start || !end}
            onClick={async () => {
              try {
                setErr(null);
                if (!selected || !start || !end) return;
                const res = await requestRide({
                  rideId: selected.id,
                  riderName,
                  riderStartName: start.name,
                  riderEndName: end.name,
                  riderStartTime: new Date(startTime).toISOString(),
                  riderStart: start.lngLat,
                  riderEnd: end.lngLat,
                });
                setRequested(res);
                listRequests().then(setMyRequests).catch(console.error);
              } catch (e: any) {
                setErr(e?.response?.data?.message ?? e?.message ?? 'Request failed');
              }
            }}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #e5e7eb',
              background: selected ? '#2563eb' : '#9ca3af',
              color: '#fff',
              cursor: selected ? 'pointer' : 'not-allowed',
              width: '100%',
            }}
          >
            Request selected ride
          </button>
          {requested && (
            <div style={{ marginTop: 10, padding: 12, borderRadius: 12, border: '1px solid #e5e7eb', background: '#f9fafb' }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Request created</div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>{requested.id}</div>
              <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>Status: {requested.status}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Driver must accept/reject in Driver dashboard.
              </div>
            </div>
          )}

          <div style={{ marginTop: 24, padding: 16, borderTop: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>My Requests</div>
            {myRequests.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No requests made yet.</div>}
            <div style={{ display: 'grid', gap: 10 }}>
              {myRequests.map(req => (
                <div key={req.id} style={{ padding: 12, borderRadius: 12, border: '1px solid #e5e7eb', background: '#f9fafb' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{req.riderName}</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: req.status === 'ACCEPTED' ? '#16a34a' : req.status === 'REJECTED' ? '#dc2626' : '#6b7280' }}>{req.status}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                    {req.riderStartName} → {req.riderEndName}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Time: {new Date(req.riderStartTime).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section style={{ minHeight: 0 }}>
        <RouteMap
          center={center}
          start={start?.lngLat ?? null}
          end={end?.lngLat ?? null}
          route={null}
        />
      </section>
    </div>
  );
}

