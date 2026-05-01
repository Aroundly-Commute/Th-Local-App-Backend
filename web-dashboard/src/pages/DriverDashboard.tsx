import { useMemo, useState, useEffect } from 'react';
import { LocationAutocomplete, type LocationValue } from '../components/search/LocationAutocomplete';
import { RouteMap } from '../components/map/RouteMap';
import { useLocation } from '../hooks/useLocation';
import { directionsRoute } from '../services/mapbox';
import { publishRide, updateRequestStatus, listRides } from '../services/api';
import { useMatchmakingRequests } from '../hooks/useMatchmaking';

function isoLocalNowPlus(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

export default function DriverDashboard() {
  const { location } = useLocation();

  const [driverName, setDriverName] = useState('Driver 1');
  const [chargeCents, setChargeCents] = useState(5000);
  const [seats, setSeats] = useState(1);

  const [start, setStart] = useState<LocationValue | null>(null);
  const [end, setEnd] = useState<LocationValue | null>(null);
  const [startTime, setStartTime] = useState(isoLocalNowPlus(30));
  const [endTime, setEndTime] = useState(isoLocalNowPlus(90));

  const [route, setRoute] = useState<{ geometry: { lng: number; lat: number }[]; distanceMeters: number; durationSeconds: number } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishedRideId, setPublishedRideId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  
  const [publishedRides, setPublishedRides] = useState<any[]>([]);

  useEffect(() => {
    listRides().then(setPublishedRides).catch(console.error);
  }, []);

  const { requests } = useMatchmakingRequests(publishedRideId ?? undefined);

  const canRoute = !!start && !!end;
  const canPublish = !!route && !!start && !!end;

  const center = useMemo(() => location ?? start?.lngLat ?? end?.lngLat ?? null, [location, start?.lngLat, end?.lngLat]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', height: '100%' }}>
      <section style={{ padding: 16, borderRight: '1px solid #e5e7eb', overflow: 'auto' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Driver dashboard</div>

        <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Driver name</label>
            <input
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Charges (cents)</label>
              <input
                type="number"
                value={chargeCents}
                min={0}
                onChange={(e) => setChargeCents(Number(e.target.value))}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Seats</label>
              <input
                type="number"
                value={seats}
                min={1}
                onChange={(e) => setSeats(Number(e.target.value))}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <LocationAutocomplete label="Start location" value={start} onChange={(v) => { setStart(v); setRoute(null); }} proximity={center} />
          <LocationAutocomplete label="End location" value={end} onChange={(v) => { setEnd(v); setRoute(null); }} proximity={center} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Start time</label>
              <input
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>End time</label>
              <input
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #e5e7eb' }}
              />
            </div>
          </div>

          <button
            disabled={!canRoute}
            onClick={async () => {
              try {
                setErr(null);
                if (!start || !end) return;
                const r = await directionsRoute(start.lngLat, end.lngLat);
                setRoute(r);
              } catch (e: any) {
                setErr(e?.response?.data?.message ?? e?.message ?? 'Failed to get route');
              }
            }}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #e5e7eb',
              background: canRoute ? '#111827' : '#9ca3af',
              color: '#fff',
              cursor: canRoute ? 'pointer' : 'not-allowed',
            }}
          >
            Get route
          </button>

          <button
            disabled={!canPublish || publishing}
            onClick={async () => {
              try {
                setPublishing(true);
                setErr(null);
                if (!start || !end || !route) return;
                const res = await publishRide({
                  driverName,
                  chargeCents,
                  seatsAvailable: seats,
                  startTime: new Date(startTime).toISOString(),
                  endTime: new Date(endTime).toISOString(),
                  startPlaceName: start.name,
                  endPlaceName: end.name,
                  start: start.lngLat,
                  end: end.lngLat,
                  route: route.geometry,
                });
                setPublishedRideId(res.id);
                listRides().then(setPublishedRides).catch(console.error);
              } catch (e: any) {
                setErr(e?.response?.data?.message ?? e?.message ?? 'Publish failed');
              } finally {
                setPublishing(false);
              }
            }}
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              border: '1px solid #e5e7eb',
              background: canPublish ? '#2563eb' : '#9ca3af',
              color: '#fff',
              cursor: canPublish ? 'pointer' : 'not-allowed',
            }}
          >
            Publish ride
          </button>

          <div style={{ marginTop: 24, padding: 16, borderTop: '1px solid #e5e7eb' }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>My Published Rides</div>
            {publishedRides.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No rides published yet.</div>}
            <div style={{ display: 'grid', gap: 10 }}>
              {publishedRides.map(ride => (
                <button
                  key={ride.id}
                  onClick={() => setPublishedRideId(ride.id === publishedRideId ? null : ride.id)}
                  style={{
                    textAlign: 'left',
                    padding: 12,
                    borderRadius: 12,
                    border: '1px solid #e5e7eb',
                    background: publishedRideId === ride.id ? '#eff6ff' : '#f9fafb',
                    cursor: 'pointer'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{ride.driverName}</div>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>{new Date(ride.startTime).toLocaleString()}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                    {ride.startPlaceName} → {ride.endPlaceName}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>ID: {ride.id}</div>
                </button>
              ))}
            </div>
          </div>

          {err && <div style={{ padding: 12, borderRadius: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>{err}</div>}
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Ride requests</div>
          {!publishedRideId && <div style={{ fontSize: 12, color: '#6b7280' }}>Publish a ride to start receiving requests.</div>}
          {!!publishedRideId && requests.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>No requests yet.</div>}
          {!!publishedRideId &&
            requests.map((r) => (
              <div key={r.id} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{r.riderName}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{r.status}</div>
                </div>
                <div style={{ fontSize: 12, color: '#374151', marginTop: 6 }}>
                  {r.riderStartName} → {r.riderEndName}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    disabled={r.status !== 'REQUESTED'}
                    onClick={async () => updateRequestStatus(r.id, 'ACCEPTED')}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #bbf7d0',
                      background: r.status === 'REQUESTED' ? '#16a34a' : '#9ca3af',
                      color: '#fff',
                      cursor: r.status === 'REQUESTED' ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Accept
                  </button>
                  <button
                    disabled={r.status !== 'REQUESTED'}
                    onClick={async () => updateRequestStatus(r.id, 'REJECTED')}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid #fecaca',
                      background: r.status === 'REQUESTED' ? '#dc2626' : '#9ca3af',
                      color: '#fff',
                      cursor: r.status === 'REQUESTED' ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
        </div>
      </section>

      <section style={{ minHeight: 0 }}>
        <RouteMap
          center={center}
          start={start?.lngLat ?? null}
          end={end?.lngLat ?? null}
          route={route?.geometry ?? null}
        />
      </section>
    </div>
  );
}

