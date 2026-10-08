import { describe, expect, it } from 'vitest';
import { isEmail } from '../src/core/validate.ts';
import { MAIL_CASES, copiesFor, duplicateMailDomains, mailCasePeople } from '../scripts/mail-cases.ts';

describe('名單信箱案例', () => {
  it('每個平台多位，熱門平台更多，名稱是一般人名', () => {
    expect(MAIL_CASES.length).toBeGreaterThanOrEqual(300);
    expect(duplicateMailDomains()).toEqual([]);
    expect(copiesFor('gmail.com')).toBeGreaterThan(copiesFor('hey.com'));
    expect(copiesFor('hotmail.com')).toBeGreaterThan(copiesFor('hushmail.com'));
    expect(copiesFor('qq.com')).toBeGreaterThan(copiesFor('eyou.com'));

    const emails = new Set<string>();
    for (const [index, item] of MAIL_CASES.entries()) {
      const people = mailCasePeople(item.domain, index);
      expect(people.length).toBeGreaterThanOrEqual(3);
      expect(people.length).toBe(copiesFor(item.domain));
      const names = new Set(people.map((person) => person.name));
      expect(names.size).toBe(people.length);
      for (const person of people) {
        expect(isEmail(person.email), person.email).toBe(true);
        expect(person.email.endsWith(`@${item.domain}`)).toBe(true);
        expect(person.name).not.toContain('·');
        expect(person.name).not.toContain(item.brand);
        expect(emails.has(person.email)).toBe(false);
        emails.add(person.email);
      }
    }
  });
});
