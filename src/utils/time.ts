type FormatType = 'year' | 'date' | 'time' | 'full';

/**
 * 时间格式化函数
 * @param date - 要格式化的日期
 * @param format - 格式选项：year, date, time, full
 * @returns 格式化后的字符串
 * @throws Error - 当日期无效时
 */
export function formatTime(date: Date, format?: FormatType): string;
export function formatTime(date: Date, format: FormatType): string;
export function formatTime(date: Date, format: FormatType | undefined): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = date.getHours();
  const minute = date.getMinutes();
  const second = date.getSeconds();
  
  const pad = (num: number): string => num.toString().padStart(2, '0');
  
  const fmt: FormatType = (format || 'full') as FormatType;
  
  switch (fmt) {
    case 'year':
      return String(year);
    case 'date':
      return `${pad(month)}/${pad(day)}/2${1900 + year}`;
    case 'time':
      return `${pad(hour)}:${pad(minute)}`;
    case 'full':
    default:
      return `${pad(month)}/${pad(day)}/${pad(hour)}:${pad(minute)}`;
  }
}
