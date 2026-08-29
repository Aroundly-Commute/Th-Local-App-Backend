import { Injectable, Logger } from '@nestjs/common';

export interface GeoLocationResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  placeId?: string;
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

  /**
   * Geocode a text query (address or landmark) into latitude, longitude, and formatted address.
   * Prioritizes Google Maps Geocoding API, falls back to OpenStreetMap Nominatim.
   */
  async geocode(query: string, countryCode = 'IN'): Promise<GeoLocationResult | null> {
    if (!query || query.trim().length === 0) return null;
    const cleanQuery = query.trim();

    // 1. Try Google Maps Geocoding API if key is available
    if (this.googleMapsApiKey && this.googleMapsApiKey !== 'your-google-maps-api-key') {
      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(cleanQuery)}&components=country:${countryCode}&key=${this.googleMapsApiKey}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.status === 'OK' && data.results && data.results.length > 0) {
          const first = data.results[0];
          return {
            lat: first.geometry.location.lat,
            lng: first.geometry.location.lng,
            formattedAddress: first.formatted_address || cleanQuery,
            placeId: first.place_id,
          };
        }
      } catch (err: any) {
        this.logger.warn(`Google Maps Geocoding failed: ${err?.message}, falling back to OpenStreetMap`);
      }
    }

    // 2. Fallback to OpenStreetMap Nominatim (Free, No API Key Required)
    try {
      const osmUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanQuery)}&countrycodes=${countryCode.toLowerCase()}&limit=1`;
      const osmRes = await fetch(osmUrl, {
        headers: { 'User-Agent': 'The34-Carpool-Backend/1.0' },
      });
      const osmData = await osmRes.json();
      if (Array.isArray(osmData) && osmData.length > 0) {
        const first = osmData[0];
        return {
          lat: parseFloat(first.lat),
          lng: parseFloat(first.lon),
          formattedAddress: first.display_name || cleanQuery,
          placeId: String(first.place_id),
        };
      }
    } catch (err: any) {
      this.logger.error(`OpenStreetMap Nominatim Geocoding failed: ${err?.message}`);
    }

    return null;
  }

  /**
   * Reverse geocode coordinates into a human-readable place name.
   */
  async reverseGeocode(lat: number, lng: number): Promise<string> {
    if (this.googleMapsApiKey && this.googleMapsApiKey !== 'your-google-maps-api-key') {
      try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${this.googleMapsApiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 'OK' && data.results && data.results.length > 0) {
          return data.results[0].formatted_address;
        }
      } catch (err) {
        // Fallback to OSM
      }
    }

    try {
      const osmUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
      const osmRes = await fetch(osmUrl, {
        headers: { 'User-Agent': 'The34-Carpool-Backend/1.0' },
      });
      const osmData = await osmRes.json();
      if (osmData && osmData.display_name) {
        return osmData.display_name;
      }
    } catch (e) {}

    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}
