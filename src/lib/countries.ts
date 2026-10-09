/**
 * Countries, with the currency and the timezone a salon there most likely uses.
 *
 * Picking a country fills in the other two, which is right almost always and
 * wrong occasionally -- a salon in Kinshasa and one in Lubumbashi keep
 * different clocks. So the timezone stays editable, and the full IANA list is
 * offered rather than just the suggestion.
 *
 * `zone` is the country's principal timezone, not its only one.
 */

export interface Country {
  code: string;
  name: string;
  currency: string;
  zone: string;
}

export const COUNTRIES: Country[] = [
  { code: "AF", name: "Afghanistan", currency: "AFN", zone: "Asia/Kabul" },
  { code: "AL", name: "Albania", currency: "ALL", zone: "Europe/Tirane" },
  { code: "DZ", name: "Algeria", currency: "DZD", zone: "Africa/Algiers" },
  { code: "AD", name: "Andorra", currency: "EUR", zone: "Europe/Andorra" },
  { code: "AO", name: "Angola", currency: "AOA", zone: "Africa/Luanda" },
  { code: "AG", name: "Antigua and Barbuda", currency: "XCD", zone: "America/Antigua" },
  { code: "AR", name: "Argentina", currency: "ARS", zone: "America/Argentina/Buenos_Aires" },
  { code: "AM", name: "Armenia", currency: "AMD", zone: "Asia/Yerevan" },
  { code: "AU", name: "Australia", currency: "AUD", zone: "Australia/Sydney" },
  { code: "AT", name: "Austria", currency: "EUR", zone: "Europe/Vienna" },
  { code: "AZ", name: "Azerbaijan", currency: "AZN", zone: "Asia/Baku" },
  { code: "BS", name: "Bahamas", currency: "BSD", zone: "America/Nassau" },
  { code: "BH", name: "Bahrain", currency: "BHD", zone: "Asia/Bahrain" },
  { code: "BD", name: "Bangladesh", currency: "BDT", zone: "Asia/Dhaka" },
  { code: "BB", name: "Barbados", currency: "BBD", zone: "America/Barbados" },
  { code: "BY", name: "Belarus", currency: "BYN", zone: "Europe/Minsk" },
  { code: "BE", name: "Belgium", currency: "EUR", zone: "Europe/Brussels" },
  { code: "BZ", name: "Belize", currency: "BZD", zone: "America/Belize" },
  { code: "BJ", name: "Benin", currency: "XOF", zone: "Africa/Porto-Novo" },
  { code: "BT", name: "Bhutan", currency: "BTN", zone: "Asia/Thimphu" },
  { code: "BO", name: "Bolivia", currency: "BOB", zone: "America/La_Paz" },
  { code: "BA", name: "Bosnia and Herzegovina", currency: "BAM", zone: "Europe/Sarajevo" },
  { code: "BW", name: "Botswana", currency: "BWP", zone: "Africa/Gaborone" },
  { code: "BR", name: "Brazil", currency: "BRL", zone: "America/Sao_Paulo" },
  { code: "BN", name: "Brunei", currency: "BND", zone: "Asia/Brunei" },
  { code: "BG", name: "Bulgaria", currency: "BGN", zone: "Europe/Sofia" },
  { code: "BF", name: "Burkina Faso", currency: "XOF", zone: "Africa/Ouagadougou" },
  { code: "BI", name: "Burundi", currency: "BIF", zone: "Africa/Bujumbura" },
  { code: "KH", name: "Cambodia", currency: "KHR", zone: "Asia/Phnom_Penh" },
  { code: "CM", name: "Cameroon", currency: "XAF", zone: "Africa/Douala" },
  { code: "CA", name: "Canada", currency: "CAD", zone: "America/Toronto" },
  { code: "CV", name: "Cape Verde", currency: "CVE", zone: "Atlantic/Cape_Verde" },
  { code: "CF", name: "Central African Republic", currency: "XAF", zone: "Africa/Bangui" },
  { code: "TD", name: "Chad", currency: "XAF", zone: "Africa/Ndjamena" },
  { code: "CL", name: "Chile", currency: "CLP", zone: "America/Santiago" },
  { code: "CN", name: "China", currency: "CNY", zone: "Asia/Shanghai" },
  { code: "CO", name: "Colombia", currency: "COP", zone: "America/Bogota" },
  { code: "KM", name: "Comoros", currency: "KMF", zone: "Indian/Comoro" },
  { code: "CG", name: "Congo", currency: "XAF", zone: "Africa/Brazzaville" },
  { code: "CD", name: "Congo (DRC)", currency: "CDF", zone: "Africa/Kinshasa" },
  { code: "CR", name: "Costa Rica", currency: "CRC", zone: "America/Costa_Rica" },
  { code: "CI", name: "Côte d'Ivoire", currency: "XOF", zone: "Africa/Abidjan" },
  { code: "HR", name: "Croatia", currency: "EUR", zone: "Europe/Zagreb" },
  { code: "CU", name: "Cuba", currency: "CUP", zone: "America/Havana" },
  { code: "CY", name: "Cyprus", currency: "EUR", zone: "Asia/Nicosia" },
  { code: "CZ", name: "Czechia", currency: "CZK", zone: "Europe/Prague" },
  { code: "DK", name: "Denmark", currency: "DKK", zone: "Europe/Copenhagen" },
  { code: "DJ", name: "Djibouti", currency: "DJF", zone: "Africa/Djibouti" },
  { code: "DM", name: "Dominica", currency: "XCD", zone: "America/Dominica" },
  { code: "DO", name: "Dominican Republic", currency: "DOP", zone: "America/Santo_Domingo" },
  { code: "EC", name: "Ecuador", currency: "USD", zone: "America/Guayaquil" },
  { code: "EG", name: "Egypt", currency: "EGP", zone: "Africa/Cairo" },
  { code: "SV", name: "El Salvador", currency: "USD", zone: "America/El_Salvador" },
  { code: "GQ", name: "Equatorial Guinea", currency: "XAF", zone: "Africa/Malabo" },
  { code: "ER", name: "Eritrea", currency: "ERN", zone: "Africa/Asmara" },
  { code: "EE", name: "Estonia", currency: "EUR", zone: "Europe/Tallinn" },
  { code: "SZ", name: "Eswatini", currency: "SZL", zone: "Africa/Mbabane" },
  { code: "ET", name: "Ethiopia", currency: "ETB", zone: "Africa/Addis_Ababa" },
  { code: "FJ", name: "Fiji", currency: "FJD", zone: "Pacific/Fiji" },
  { code: "FI", name: "Finland", currency: "EUR", zone: "Europe/Helsinki" },
  { code: "FR", name: "France", currency: "EUR", zone: "Europe/Paris" },
  { code: "GA", name: "Gabon", currency: "XAF", zone: "Africa/Libreville" },
  { code: "GM", name: "Gambia", currency: "GMD", zone: "Africa/Banjul" },
  { code: "GE", name: "Georgia", currency: "GEL", zone: "Asia/Tbilisi" },
  { code: "DE", name: "Germany", currency: "EUR", zone: "Europe/Berlin" },
  { code: "GH", name: "Ghana", currency: "GHS", zone: "Africa/Accra" },
  { code: "GR", name: "Greece", currency: "EUR", zone: "Europe/Athens" },
  { code: "GD", name: "Grenada", currency: "XCD", zone: "America/Grenada" },
  { code: "GT", name: "Guatemala", currency: "GTQ", zone: "America/Guatemala" },
  { code: "GN", name: "Guinea", currency: "GNF", zone: "Africa/Conakry" },
  { code: "GW", name: "Guinea-Bissau", currency: "XOF", zone: "Africa/Bissau" },
  { code: "GY", name: "Guyana", currency: "GYD", zone: "America/Guyana" },
  { code: "HT", name: "Haiti", currency: "HTG", zone: "America/Port-au-Prince" },
  { code: "HN", name: "Honduras", currency: "HNL", zone: "America/Tegucigalpa" },
  { code: "HK", name: "Hong Kong", currency: "HKD", zone: "Asia/Hong_Kong" },
  { code: "HU", name: "Hungary", currency: "HUF", zone: "Europe/Budapest" },
  { code: "IS", name: "Iceland", currency: "ISK", zone: "Atlantic/Reykjavik" },
  { code: "IN", name: "India", currency: "INR", zone: "Asia/Kolkata" },
  { code: "ID", name: "Indonesia", currency: "IDR", zone: "Asia/Jakarta" },
  { code: "IR", name: "Iran", currency: "IRR", zone: "Asia/Tehran" },
  { code: "IQ", name: "Iraq", currency: "IQD", zone: "Asia/Baghdad" },
  { code: "IE", name: "Ireland", currency: "EUR", zone: "Europe/Dublin" },
  { code: "IL", name: "Israel", currency: "ILS", zone: "Asia/Jerusalem" },
  { code: "IT", name: "Italy", currency: "EUR", zone: "Europe/Rome" },
  { code: "JM", name: "Jamaica", currency: "JMD", zone: "America/Jamaica" },
  { code: "JP", name: "Japan", currency: "JPY", zone: "Asia/Tokyo" },
  { code: "JO", name: "Jordan", currency: "JOD", zone: "Asia/Amman" },
  { code: "KZ", name: "Kazakhstan", currency: "KZT", zone: "Asia/Almaty" },
  { code: "KE", name: "Kenya", currency: "KES", zone: "Africa/Nairobi" },
  { code: "KW", name: "Kuwait", currency: "KWD", zone: "Asia/Kuwait" },
  { code: "KG", name: "Kyrgyzstan", currency: "KGS", zone: "Asia/Bishkek" },
  { code: "LA", name: "Laos", currency: "LAK", zone: "Asia/Vientiane" },
  { code: "LV", name: "Latvia", currency: "EUR", zone: "Europe/Riga" },
  { code: "LB", name: "Lebanon", currency: "LBP", zone: "Asia/Beirut" },
  { code: "LS", name: "Lesotho", currency: "LSL", zone: "Africa/Maseru" },
  { code: "LR", name: "Liberia", currency: "LRD", zone: "Africa/Monrovia" },
  { code: "LY", name: "Libya", currency: "LYD", zone: "Africa/Tripoli" },
  { code: "LI", name: "Liechtenstein", currency: "CHF", zone: "Europe/Vaduz" },
  { code: "LT", name: "Lithuania", currency: "EUR", zone: "Europe/Vilnius" },
  { code: "LU", name: "Luxembourg", currency: "EUR", zone: "Europe/Luxembourg" },
  { code: "MG", name: "Madagascar", currency: "MGA", zone: "Indian/Antananarivo" },
  { code: "MW", name: "Malawi", currency: "MWK", zone: "Africa/Blantyre" },
  { code: "MY", name: "Malaysia", currency: "MYR", zone: "Asia/Kuala_Lumpur" },
  { code: "MV", name: "Maldives", currency: "MVR", zone: "Indian/Maldives" },
  { code: "ML", name: "Mali", currency: "XOF", zone: "Africa/Bamako" },
  { code: "MT", name: "Malta", currency: "EUR", zone: "Europe/Malta" },
  { code: "MR", name: "Mauritania", currency: "MRU", zone: "Africa/Nouakchott" },
  { code: "MU", name: "Mauritius", currency: "MUR", zone: "Indian/Mauritius" },
  { code: "MX", name: "Mexico", currency: "MXN", zone: "America/Mexico_City" },
  { code: "MD", name: "Moldova", currency: "MDL", zone: "Europe/Chisinau" },
  { code: "MC", name: "Monaco", currency: "EUR", zone: "Europe/Monaco" },
  { code: "MN", name: "Mongolia", currency: "MNT", zone: "Asia/Ulaanbaatar" },
  { code: "ME", name: "Montenegro", currency: "EUR", zone: "Europe/Podgorica" },
  { code: "MA", name: "Morocco", currency: "MAD", zone: "Africa/Casablanca" },
  { code: "MZ", name: "Mozambique", currency: "MZN", zone: "Africa/Maputo" },
  { code: "MM", name: "Myanmar", currency: "MMK", zone: "Asia/Yangon" },
  { code: "NA", name: "Namibia", currency: "NAD", zone: "Africa/Windhoek" },
  { code: "NP", name: "Nepal", currency: "NPR", zone: "Asia/Kathmandu" },
  { code: "NL", name: "Netherlands", currency: "EUR", zone: "Europe/Amsterdam" },
  { code: "NZ", name: "New Zealand", currency: "NZD", zone: "Pacific/Auckland" },
  { code: "NI", name: "Nicaragua", currency: "NIO", zone: "America/Managua" },
  { code: "NE", name: "Niger", currency: "XOF", zone: "Africa/Niamey" },
  { code: "NG", name: "Nigeria", currency: "NGN", zone: "Africa/Lagos" },
  { code: "MK", name: "North Macedonia", currency: "MKD", zone: "Europe/Skopje" },
  { code: "NO", name: "Norway", currency: "NOK", zone: "Europe/Oslo" },
  { code: "OM", name: "Oman", currency: "OMR", zone: "Asia/Muscat" },
  { code: "PK", name: "Pakistan", currency: "PKR", zone: "Asia/Karachi" },
  { code: "PS", name: "Palestine", currency: "ILS", zone: "Asia/Hebron" },
  { code: "PA", name: "Panama", currency: "PAB", zone: "America/Panama" },
  { code: "PG", name: "Papua New Guinea", currency: "PGK", zone: "Pacific/Port_Moresby" },
  { code: "PY", name: "Paraguay", currency: "PYG", zone: "America/Asuncion" },
  { code: "PE", name: "Peru", currency: "PEN", zone: "America/Lima" },
  { code: "PH", name: "Philippines", currency: "PHP", zone: "Asia/Manila" },
  { code: "PL", name: "Poland", currency: "PLN", zone: "Europe/Warsaw" },
  { code: "PT", name: "Portugal", currency: "EUR", zone: "Europe/Lisbon" },
  { code: "QA", name: "Qatar", currency: "QAR", zone: "Asia/Qatar" },
  { code: "RO", name: "Romania", currency: "RON", zone: "Europe/Bucharest" },
  { code: "RU", name: "Russia", currency: "RUB", zone: "Europe/Moscow" },
  { code: "RW", name: "Rwanda", currency: "RWF", zone: "Africa/Kigali" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR", zone: "Asia/Riyadh" },
  { code: "SN", name: "Senegal", currency: "XOF", zone: "Africa/Dakar" },
  { code: "RS", name: "Serbia", currency: "RSD", zone: "Europe/Belgrade" },
  { code: "SC", name: "Seychelles", currency: "SCR", zone: "Indian/Mahe" },
  { code: "SL", name: "Sierra Leone", currency: "SLE", zone: "Africa/Freetown" },
  { code: "SG", name: "Singapore", currency: "SGD", zone: "Asia/Singapore" },
  { code: "SK", name: "Slovakia", currency: "EUR", zone: "Europe/Bratislava" },
  { code: "SI", name: "Slovenia", currency: "EUR", zone: "Europe/Ljubljana" },
  { code: "SO", name: "Somalia", currency: "SOS", zone: "Africa/Mogadishu" },
  { code: "ZA", name: "South Africa", currency: "ZAR", zone: "Africa/Johannesburg" },
  { code: "KR", name: "South Korea", currency: "KRW", zone: "Asia/Seoul" },
  { code: "SS", name: "South Sudan", currency: "SSP", zone: "Africa/Juba" },
  { code: "ES", name: "Spain", currency: "EUR", zone: "Europe/Madrid" },
  { code: "LK", name: "Sri Lanka", currency: "LKR", zone: "Asia/Colombo" },
  { code: "SD", name: "Sudan", currency: "SDG", zone: "Africa/Khartoum" },
  { code: "SR", name: "Suriname", currency: "SRD", zone: "America/Paramaribo" },
  { code: "SE", name: "Sweden", currency: "SEK", zone: "Europe/Stockholm" },
  { code: "CH", name: "Switzerland", currency: "CHF", zone: "Europe/Zurich" },
  { code: "SY", name: "Syria", currency: "SYP", zone: "Asia/Damascus" },
  { code: "TW", name: "Taiwan", currency: "TWD", zone: "Asia/Taipei" },
  { code: "TJ", name: "Tajikistan", currency: "TJS", zone: "Asia/Dushanbe" },
  { code: "TZ", name: "Tanzania", currency: "TZS", zone: "Africa/Dar_es_Salaam" },
  { code: "TH", name: "Thailand", currency: "THB", zone: "Asia/Bangkok" },
  { code: "TG", name: "Togo", currency: "XOF", zone: "Africa/Lome" },
  { code: "TT", name: "Trinidad and Tobago", currency: "TTD", zone: "America/Port_of_Spain" },
  { code: "TN", name: "Tunisia", currency: "TND", zone: "Africa/Tunis" },
  { code: "TR", name: "Türkiye", currency: "TRY", zone: "Europe/Istanbul" },
  { code: "TM", name: "Turkmenistan", currency: "TMT", zone: "Asia/Ashgabat" },
  { code: "UG", name: "Uganda", currency: "UGX", zone: "Africa/Kampala" },
  { code: "UA", name: "Ukraine", currency: "UAH", zone: "Europe/Kyiv" },
  { code: "AE", name: "United Arab Emirates", currency: "AED", zone: "Asia/Dubai" },
  { code: "GB", name: "United Kingdom", currency: "GBP", zone: "Europe/London" },
  { code: "US", name: "United States", currency: "USD", zone: "America/New_York" },
  { code: "UY", name: "Uruguay", currency: "UYU", zone: "America/Montevideo" },
  { code: "UZ", name: "Uzbekistan", currency: "UZS", zone: "Asia/Tashkent" },
  { code: "VE", name: "Venezuela", currency: "VES", zone: "America/Caracas" },
  { code: "VN", name: "Vietnam", currency: "VND", zone: "Asia/Ho_Chi_Minh" },
  { code: "YE", name: "Yemen", currency: "YER", zone: "Asia/Aden" },
  { code: "ZM", name: "Zambia", currency: "ZMW", zone: "Africa/Lusaka" },
  { code: "ZW", name: "Zimbabwe", currency: "ZWG", zone: "Africa/Harare" },
];

const BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));
const BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

/** Look a country up by name or ISO code, case-insensitively. */
export function findCountry(value: string | null | undefined): Country | null {
  if (!value) return null;
  const key = value.trim();
  return BY_CODE.get(key.toUpperCase()) ?? BY_NAME.get(key.toLowerCase()) ?? null;
}

export function currencyFor(country: string | null | undefined): string | null {
  return findCountry(country)?.currency ?? null;
}

export function timezoneFor(country: string | null | undefined): string | null {
  return findCountry(country)?.zone ?? null;
}

/**
 * Every IANA timezone the runtime knows, so a salon whose country spans
 * several is not forced onto the capital's clock. Falls back to the countries'
 * own zones on a runtime without `supportedValuesOf`.
 */
export function allTimeZones(): string[] {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;

  if (typeof supported === "function") {
    try {
      return supported.call(Intl, "timeZone");
    } catch {
      /* fall through */
    }
  }
  return [...new Set(COUNTRIES.map((c) => c.zone))].sort();
}
