const TOKYO_TIME_ZONE = 'Asia/Tokyo';

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: TOKYO_TIME_ZONE,
});

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  timeZone: TOKYO_TIME_ZONE,
});

const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: TOKYO_TIME_ZONE,
});

const toValidDate = (value?: string | number | Date | null) => {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

export const formatDateTimeJP = (value?: string | number | Date | null, fallback = '-') => {
  const date = toValidDate(value);
  return date ? dateTimeFormatter.format(date) : fallback;
};

export const formatDateJP = (value?: string | number | Date | null, fallback = '-') => {
  const date = toValidDate(value);
  return date ? dateFormatter.format(date) : fallback;
};

export const formatTimeJP = (value?: string | number | Date | null, fallback = '') => {
  const date = toValidDate(value);
  return date ? timeFormatter.format(date) : fallback;
};
