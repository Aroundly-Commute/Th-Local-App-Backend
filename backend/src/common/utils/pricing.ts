/**
 * Uber-like Shared Ride Fare Estimation Engine
 * Designed by Senior Backend Architect at Uber.
 * Calculates dynamic fair pricing in Indian Rupees (₹) incorporating:
 * - Rider distance
 * - Location premiums (NCR, Delhi, Noida, Gurgaon, Faridabad, Airport, Stations)
 * - Driver detour deviation
 * - Fuel type pricing (CNG, Petrol, Diesel)
 * - Vehicle type and capacity (2-wheel Bike, 5-seater Car, 7-seater Car)
 * - 40% Pooling discount
 * - Safety cap (private cab rates limit)
 */

export interface FareCalculationInput {
  distanceMeters: number;       // Rider's journey distance in meters
  deviationMeters: number;      // Driver detour distance in meters (pickup + dropoff deviation)
  startPlaceName: string;
  endPlaceName: string;
  vehicleType: string;          // "CAR" | "BIKE"
  vehicleCapacity: number;      // 2 | 5 | 7
  fuelType: string;             // "CNG" | "Petrol" | "Diesel"
}

export interface FareBreakdown {
  vehicleType: string;
  vehicleCapacity: number;
  fuelType: string;
  distanceKm: number;
  deviationKm: number;
  isNcrPremium: boolean;
  baseFare: number;
  locationPremium: number;
  distanceFare: number;
  fuelSurcharge: number;
  deviationSurcharge: number;
  subtotal: number;
  poolingDiscount: number;
  poolingFare: number;
  cabCapFare: number;
  finalFare: number;
}

export function calculateFare(input: FareCalculationInput): FareBreakdown {
  const distanceKm = Math.max(0, input.distanceMeters / 1000);
  const deviationKm = Math.max(0, input.deviationMeters / 1000);

  const isNcrPremium = false;

  // Pricing Matrix Variables based on Vehicle Class (Base fare & location premium removed per specification)
  let baseFare = 0.0;
  let locationPremiumRate = 0.0;
  let perKmRate = 10.0;
  let detourRate = 15.0;
  let fuelCostPerKm = 6.0; // Petrol standard
  
  let cabBase = 50.0;
  let cabPerKm = 15.0;
  let minFloor = 20.0;

  const normalizedType = input.vehicleType?.toUpperCase() || 'CAR';
  const capacity = Number(input.vehicleCapacity) || 5;
  const normalizedFuel = input.fuelType?.toUpperCase() || 'PETROL';

  if (normalizedType === 'BIKE') {
    // 2-Wheel Bike rates
    baseFare = 0.0;
    locationPremiumRate = 0.0;
    perKmRate = 4.0;
    detourRate = 5.0;
    fuelCostPerKm = 2.0; // Bikes are highly efficient
    
    cabBase = 30.0;
    cabPerKm = 6.0;
    minFloor = 15.0;
  } else if (normalizedType === 'CAR' && capacity > 5) {
    // 7-Seater Premium Car rates
    baseFare = 0.0;
    locationPremiumRate = 0.0;
    perKmRate = 12.0;
    detourRate = 20.0;
    minFloor = 30.0;

    // Fuel costs for large vehicles
    if (normalizedFuel === 'CNG') {
      fuelCostPerKm = 4.0;
    } else if (normalizedFuel === 'DIESEL') {
      fuelCostPerKm = 6.0;
    } else {
      fuelCostPerKm = 7.0; // Petrol
    }

    cabBase = 80.0;
    cabPerKm = 18.0;
  } else {
    // 5-Seater standard Car rates
    baseFare = 0.0;
    locationPremiumRate = 0.0;
    perKmRate = 10.0;
    detourRate = 15.0;
    minFloor = 20.0;

    // Fuel costs for standard cars
    if (normalizedFuel === 'CNG') {
      fuelCostPerKm = 3.0;
    } else if (normalizedFuel === 'DIESEL') {
      fuelCostPerKm = 5.0;
    } else {
      fuelCostPerKm = 6.0; // Petrol
    }

    cabBase = 50.0;
    cabPerKm = 15.0;
  }

  // Components Calculation (Distance fare + Fuel surcharge + Detour surcharge)
  const locationPremium = 0.0;
  const distanceFare = distanceKm * perKmRate;
  const fuelSurcharge = distanceKm * fuelCostPerKm;
  const deviationSurcharge = deviationKm * detourRate;

  const variableSubtotal = distanceFare + fuelSurcharge + deviationSurcharge + locationPremium;
  const variablePooledFare = variableSubtotal * 0.60;

  const targetMinFare = normalizedType === 'BIKE' ? 20.0 : 30.0;

  // If variable pooled fare is less than minimum threshold, increase base fare to meet target minimum pooled fare exactly
  baseFare = 0.0;
  if (variablePooledFare < targetMinFare) {
    baseFare = (targetMinFare / 0.60) - variableSubtotal;
  }

  // Subtotal & 40% Pooling Discount
  const subtotal = baseFare + variableSubtotal;
  const poolingDiscount = subtotal * 0.40;
  const poolingFare = subtotal - poolingDiscount;

  // Cab Safety Surcharge Cap Slashes
  const cabCapFare = cabBase + distanceKm * cabPerKm;

  // Final Fare is minimum of pooling fare and private cab fare, bounded by target minimum threshold
  const finalFare = Math.max(targetMinFare, Math.min(poolingFare, cabCapFare));

  return {
    vehicleType: normalizedType,
    vehicleCapacity: capacity,
    fuelType: normalizedFuel,
    distanceKm: Number(distanceKm.toFixed(2)),
    deviationKm: Number(deviationKm.toFixed(2)),
    isNcrPremium: false,
    baseFare: Number(baseFare.toFixed(2)),
    locationPremium: 0.0,
    distanceFare: Number(distanceFare.toFixed(2)),
    fuelSurcharge: Number(fuelSurcharge.toFixed(2)),
    deviationSurcharge: Number(deviationSurcharge.toFixed(2)),
    subtotal: Number(subtotal.toFixed(2)),
    poolingDiscount: Number(poolingDiscount.toFixed(2)),
    poolingFare: Number(poolingFare.toFixed(2)),
    cabCapFare: Number(cabCapFare.toFixed(2)),
    finalFare: Math.round(finalFare),
  };
}
