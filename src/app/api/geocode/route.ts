import { NextRequest, NextResponse } from 'next/server';
import { Coordinates } from '@/types/job';

// Base location for distance calculations (Noosa area)
const BASE_LOCATION: Coordinates = { lat: -26.3955, lng: 153.0937 };

export async function POST(request: NextRequest) {
  try {
    const { address, suburb, postcode } = await request.json();

    // For demo purposes, we'll use a simple suburb-to-coordinates mapping
    // In production, you'd use Google Maps Geocoding API or similar service
    const result = await geocodeAddress(address, suburb, postcode);

    return NextResponse.json(result);
  } catch (error) {
    console.error('Geocoding error:', error);
    return NextResponse.json(
      { error: 'Failed to geocode address' },
      { status: 500 }
    );
  }
}

// Simple geocoding function - in production, use Google Maps API
async function geocodeAddress(address?: string, suburb?: string, postcode?: string) {
  // Sunshine Coast area suburb coordinates (approximate)
  const suburbCoordinates: { [key: string]: Coordinates } = {
    'noosa': { lat: -26.3955, lng: 153.0937 },
    'cooroy': { lat: -26.4174, lng: 152.9159 },
    'doonan': { lat: -26.4033, lng: 153.0631 },
    'eumundi': { lat: -26.4589, lng: 152.9547 },
    'tewantin': { lat: -26.3889, lng: 153.0394 },
    'pomona': { lat: -26.3684, lng: 152.8548 },
    'kin kin': { lat: -26.3467, lng: 152.8891 },
    'boreen point': { lat: -26.3333, lng: 153.0167 },
    'tinbeerwah': { lat: -26.3333, lng: 152.9667 },
    'peregian': { lat: -26.4833, lng: 153.0833 },
    'sunrise beach': { lat: -26.4500, lng: 153.0833 },
    'marcus beach': { lat: -26.4333, lng: 153.0833 },
    'castaways beach': { lat: -26.4167, lng: 153.0833 },
    'sunshine beach': { lat: -26.4000, lng: 153.1000 },
    'peregian beach': { lat: -26.4667, lng: 153.0833 }
  };

  let coordinates: Coordinates | undefined;
  let confidence = 0.5; // Default confidence

  // Try to find coordinates by suburb
  if (suburb) {
    const normalizedSuburb = suburb.toLowerCase().trim();
    coordinates = suburbCoordinates[normalizedSuburb];

    if (coordinates) {
      confidence = 0.8; // Good confidence for known suburb
    }
  }

  // If no coordinates found, try postcode-based estimation
  if (!coordinates && postcode) {
    coordinates = estimateCoordinatesByPostcode(postcode);
    if (coordinates) {
      confidence = 0.6; // Lower confidence for postcode estimation
    }
  }

  // If still no coordinates, use a default in the Sunshine Coast area
  if (!coordinates) {
    coordinates = BASE_LOCATION;
    confidence = 0.3; // Low confidence for default location
  }

  // Calculate distance from base
  const distanceFromBase = calculateDistance(BASE_LOCATION, coordinates);

  // Estimate travel time (assuming average 60km/h with stops)
  const travelTime = Math.round(distanceFromBase * 1.2); // Add 20% for stops

  return {
    coordinates,
    distanceFromBase: Math.round(distanceFromBase),
    travelTime,
    confidence,
    suburb: suburb || 'Unknown',
    postcode: postcode || undefined
  };
}

// Simple postcode to coordinates estimation
function estimateCoordinatesByPostcode(postcode: string): Coordinates | undefined {
  const code = parseInt(postcode);

  // Sunshine Coast postcodes (4560-4575)
  if (code >= 4560 && code <= 4575) {
    // Rough estimation based on postcode
    const latOffset = (code - 4565) * 0.02; // Approximate offset per postcode
    return {
      lat: -26.4 + latOffset,
      lng: 153.0
    };
  }

  // Brisbane area (4000-4299)
  if (code >= 4000 && code <= 4299) {
    return { lat: -27.4698, lng: 153.0251 };
  }

  // Gold Coast area (4210-4230)
  if (code >= 4210 && code <= 4230) {
    return { lat: -28.0167, lng: 153.4000 };
  }

  return undefined; // Unknown postcode
}

// Calculate distance between two coordinates (Haversine formula)
function calculateDistance(coord1: Coordinates, coord2: Coordinates): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLon = toRadians(coord2.lng - coord1.lng);

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) * Math.cos(toRadians(coord2.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in kilometers
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}