import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import type { RideStatus } from '../services/api';
import { listRequests } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

// Using the same URL logic as axios instance
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export function useMatchmakingRequests(rideId?: string) {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { token } = useAuth();

  const fetchRequests = useCallback(async () => {
    try {
      setLoading(true);
      const data = await listRequests(rideId ? { rideId } : undefined);
      setRequests(data);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, [rideId]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    if (!token) return;

    const socket: Socket = io(API_URL, {
      auth: {
        token: token
      }
    });

    socket.on('connect', () => {
      console.log('Socket connected successfully');
    });

    socket.on('new_ride_request', (newRequest: any) => {
      console.log('Received new ride request:', newRequest);
      // Depending on whether we're filtering by rideId, update state
      setRequests((prev) => {
        // If we are filtering by a specific rideId, ensure the new request belongs to it
        if (rideId && newRequest.rideId !== rideId) {
          return prev;
        }
        // Avoid duplicates if somehow fetched concurrently
        const exists = prev.some(r => r.id === newRequest.id);
        if (exists) return prev;
        return [newRequest, ...prev];
      });
    });

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err);
    });

    return () => {
      socket.disconnect();
    };
  }, [token, rideId]);

  return { requests, loading, error } as { requests: any[]; loading: boolean; error: string | null };
}

export function requestStatusLabel(s: RideStatus) {
  return s;
}

