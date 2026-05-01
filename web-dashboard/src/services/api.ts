import axios from 'axios';
import { getAuth } from 'firebase/auth';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20_000,
});

api.interceptors.request.use(async (config) => {
  const auth = getAuth();
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => Promise.reject(error));


export type RideStatus = 'OPEN' | 'REQUESTED' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';

export type LngLat = { lng: number; lat: number };

export type PublishRideInput = {
  driverName: string;
  chargeCents: number;
  seatsAvailable: number;
  startTime: string;
  endTime: string;
  startPlaceName: string;
  endPlaceName: string;
  start: LngLat;
  end: LngLat;
  route: LngLat[];
};

export async function publishRide(input: PublishRideInput) {
  const res = await api.post('/rides', input);
  return res.data;
}

export async function searchMatches(input: {
  start: LngLat;
  end: LngLat;
  startPlaceName: string;
  endPlaceName: string;
  startTime: string;
  startRadiusMeters?: number;
  endRadiusMeters?: number;
  corridorMeters?: number;
  timeWindowMinutes?: number;
}) {
  const res = await api.post('/matchmaking/search', input);
  return res.data as { matches: any[]; query: any };
}

export async function requestRide(input: {
  rideId: string;
  riderName: string;
  riderStartName: string;
  riderEndName: string;
  riderStartTime: string;
  riderStart: LngLat;
  riderEnd: LngLat;
}) {
  const res = await api.post('/matchmaking/request', input);
  return res.data;
}

export async function listRequests(params?: { rideId?: string }) {
  const res = await api.get('/matchmaking/requests', { params });
  return res.data as any[];
}

export async function listRides(status?: RideStatus) {
  const params = status ? { status } : {};
  const res = await api.get('/rides', { params });
  return res.data as any[];
}

export async function updateRequestStatus(id: string, status: RideStatus) {
  const res = await api.patch(`/matchmaking/requests/${id}`, { status });
  return res.data;
}

