import { Injectable } from '@nestjs/common';

@Injectable()
export class LocationsService {
  private readonly googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY || '';

  async suggestLocations(q: string) {
    if (!this.googleMapsApiKey || !q || q.length < 3) return [];
    try {
      const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&key=${this.googleMapsApiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      const predictions = data.predictions || [];
      return predictions.map((p: any) => ({
        id: p.place_id,
        place_name: p.description,
      }));
    } catch (e) {
      return [];
    }
  }

  async getLocationDetails(placeId: string) {
    if (!this.googleMapsApiKey || !placeId) return { error: 'Missing parameters' };
    try {
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=geometry&key=${this.googleMapsApiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      if (data.result && data.result.geometry && data.result.geometry.location) {
        return {
          lat: data.result.geometry.location.lat,
          lng: data.result.geometry.location.lng,
        };
      }
      return { error: 'No geometry found' };
    } catch (e) {
      return { error: e.message };
    }
  }

  async getDirections(origin: string, destination: string) {
    if (!this.googleMapsApiKey || !origin || !destination) {
      return { error: 'Missing parameters' };
    }
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&key=${this.googleMapsApiKey}`;
      const response = await fetch(url);
      const data = await response.json();
      return data;
    } catch (e) {
      return { error: e.message };
    }
  }
}
