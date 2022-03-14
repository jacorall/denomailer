import { assertEquals } from "https://deno.land/std@0.129.0/testing/asserts.ts";
import { quotedPrintableEncode } from "./encoding.ts";

function quotedPrintableDecode(str: string) {
  str = str.replaceAll('=\r\n', '')

  const len = str.length
  const encodedChars = len - str.replaceAll('=', '').length

  const realLength = len - 2 * encodedChars

  const buf = new ArrayBuffer(realLength)
  const arr = new Uint8Array(buf)

  let byte = 0

  const chars = Array.from(str)
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
  
    if(char === '=') {
      const byteHex = `${chars[i+1]}${chars[i+2]}`
      
      arr[byte] = parseInt(byteHex, 16)

      i += 2
    } else {
      arr[byte] = char.charCodeAt(0)
    }
    byte++
  }

  const dec = new TextDecoder()

  return dec.decode(arr)
}

const testSet = [
  `Hätten Hüte ein ß im Namen, wären sie möglicherweise keine Hüte mehr,\r\nsondern Hüße.`,
  "abc",
  "abcß2`öäü dsd sd 😉",
  `J'interdis aux marchands de vanter trop leurs marchandises. Car ils se font vite pédagogues et t'enseignent comme but ce qui n'est par essence qu'un moyen, et te trompant ainsi sur la route à suivre les voilà bientôt qui te dégradent, car si leur musique est vulgaire ils te fabriquent pour te la vendre une âme vulgaire.`,
  "😉",
  "😉🤔😁😏🤨😪😷👨‍🦱👱‍♀️👩🏿‍🦰🤴🏿🧓🏼👸🏼🎠🥿⛑👠⛳🛶🪁📢🌯🧀🥭🍊🍀🚈🚐🏪💒🌀⚡💕💯🔽⬆🕟🕔🇦🇨🇦🇷🇩🇪"
]

Deno.test('Quoted Printable', () => {
  testSet.forEach((testString, i) => {
    assertEquals(testString, quotedPrintableDecode(quotedPrintableEncode(testString)), `String ${i}`)
  })
})
