import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalize } from '../canonical.ts';

describe('canonical JSON', () => {
  it('sorts object keys recursively and drops whitespace', () => {
    assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('orders keys by UTF-16 code units (RFC 8785), including non-ASCII', () => {
    // U+00E9 (é) < U+20AC (€) < U+D83D (first unit of 😀) < U+FB01 (ﬁ) in UTF-16 order,
    // although 😀 (U+1F600) is the largest code point.
    const obj = { 'ﬁ': 1, '😀': 2, '€': 3, 'é': 4, Z: 5, a: 6, '1': 7, '': 8 };
    assert.equal(canonicalize(obj), '{"":8,"1":7,"Z":5,"a":6,"é":4,"€":3,"😀":2,"ﬁ":1}');
  });

  it('keeps array order, including nested arrays', () => {
    assert.equal(canonicalize([[3, 2], [], [1, [0]]]), '[[3,2],[],[1,[0]]]');
  });

  it('serializes numbers like JSON.stringify', () => {
    assert.equal(canonicalize([0, -0, 1, -1.5, 1e21, 1e-7, 123456789012345680000, 0.1 + 0.2]), '[0,0,1,-1.5,1e+21,1e-7,123456789012345680000,0.30000000000000004]');
  });

  it('serializes strings like JSON.stringify', () => {
    const s = 'quote" backslash\\ nl\n tab\t ctrl\u0001 é 😀 \u2028';
    assert.equal(canonicalize(s), JSON.stringify(s));
    assert.equal(canonicalize({ s }), `{"s":${JSON.stringify(s)}}`);
  });

  it('serializes booleans and null', () => {
    assert.equal(canonicalize([true, false, null]), '[true,false,null]');
  });

  it('rejects non-finite numbers', () => {
    for (const v of [NaN, Infinity, -Infinity]) assert.throws(() => canonicalize({ v }), /non-finite/);
  });

  it('rejects undefined anywhere', () => {
    assert.throws(() => canonicalize(undefined), /undefined/);
    assert.throws(() => canonicalize({ a: undefined }), /undefined/);
    assert.throws(() => canonicalize([1, undefined]), /undefined/);
  });

  it('rejects functions, symbols, bigints, sparse arrays and non-plain objects', () => {
    assert.throws(() => canonicalize({ f: () => 1 }), /unsupported/);
    assert.throws(() => canonicalize(Symbol('x')), /unsupported/);
    assert.throws(() => canonicalize(1n), /unsupported/);
    // eslint-disable-next-line no-sparse-arrays
    assert.throws(() => canonicalize([1, , 3]), /sparse/);
    assert.throws(() => canonicalize(new Date(0)), /non-plain/);
    assert.throws(() => canonicalize(new Map()), /non-plain/);
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, number>;
    o.b = 2;
    o.a = 1;
    assert.equal(canonicalize(o), '{"a":1,"b":2}');
  });

  it('round-trips: canonicalize(JSON.parse(canonical)) is stable', () => {
    const c = canonicalize({ z: [1, { y: 'é', x: 2.5 }], a: true });
    assert.equal(canonicalize(JSON.parse(c)), c);
  });
});
