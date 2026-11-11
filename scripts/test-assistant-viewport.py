"""Browser regression for iPhone focus zoom and the assistant's visible bounds.

Start npm run dev:auth, then run this with Python's playwright package installed.
Chromium uses the iPhone 15 profile and real page-scale emulation. --browser
webkit runs the same layout checks when the Playwright WebKit build is installed.
Only fictional data and a local mock transport are used.
"""
import argparse
import asyncio
import json
from playwright.async_api import async_playwright


async def bounds(page):
    result = await page.evaluate('''()=>{
      const viewport=visualViewport;
      const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
      const dialog=document.querySelector('dialog');
      return {viewport:{left:viewport.offsetLeft,top:viewport.offsetTop,right:viewport.offsetLeft+viewport.width,bottom:viewport.offsetTop+viewport.height},
        dialog:rect(dialog),close:rect(dialog.querySelector('[data-assistant-action=close]')),
        send:rect(dialog.querySelector('[aria-label="Send message"]')),
        font:parseFloat(getComputedStyle(dialog.querySelector('textarea')).fontSize),
        rootFont:getComputedStyle(document.documentElement).fontSize,
        overflow:[...dialog.querySelectorAll('*')].filter(e=>!e.classList.contains('sr-only')&&e.clientWidth&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
    }''')
    assert result['font'] >= 16, result
    for name in ['dialog', 'close', 'send']:
        r, v = result[name], result['viewport']
        assert r['left'] >= v['left']-1 and r['right'] <= v['right']+1, (name, result)
        assert r['top'] >= v['top']-1 and r['bottom'] <= v['bottom']+1, (name, result)
    assert not result['overflow'], result
    return result


async def main(args):
    async with async_playwright() as p:
        launcher = getattr(p, args.browser)
        browser = await launcher.launch(**({'executable_path':'/usr/bin/chromium','args':['--no-sandbox']} if args.browser=='chromium' else {}))
        for width, height in [(320,740), (360,800), (393,852), (430,932), (852,393)]:
            profile = {**p.devices['iPhone 15'], 'viewport':{'width':width,'height':height}}
            context = await browser.new_context(**profile)
            page = await context.new_page()
            await page.route('https://*.supabase.co/**', lambda route: route.abort())
            await page.goto(args.base_url, wait_until='networkidle')
            await page.evaluate('''async()=>{
              await import('/assistant.css');
              const {createAssistantPanel}=await import('/assistant-ui.ts');
              document.body.innerHTML='<button id="open">Open assistant</button>';
              window.panel=createAssistantPanel(document,async()=>({message:'Here are the matching scouts.',card:{kind:'results',title:'Lions needing Bobcat',items:[{label:'Synthetic Scout',detail:'Long detail '.repeat(30),scout_id:'synthetic'}]}}),()=>({den:'0-Lions',year:'2026-27',email:'synthetic@example.test'}),()=>{});
              document.querySelector('#open').focus();await window.panel.open();
            }''')
            # This must use the real app stylesheet: its root is 14px, not 16px.
            assert (await bounds(page))['rootFont']=='14px'
            if args.browser=='chromium':
                cdp = await context.new_cdp_session(page)
                for scale in [1.15, 1.4]:
                    await cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor':scale})
                    await page.wait_for_timeout(150)
                    await bounds(page)
                await cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor':1})
            await page.locator('dialog textarea').fill('Who needs Bobcat?')
            await page.get_by_role('button',name='Send message').click()
            await page.locator('.assistant-result').wait_for()
            await bounds(page)
            assert await page.evaluate('document.activeElement.id')=='assistant-message'
            await page.keyboard.type('Follow-up question')
            assert await page.locator('dialog textarea').input_value()=='Follow-up question'
            # Approximate the space above a phone keyboard, then rotate/re-expand.
            await page.set_viewport_size({'width':width,'height':min(height,330)})
            await page.wait_for_timeout(150)
            await bounds(page)
            if args.browser=='chromium':
                await cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor':1.15})
                await page.wait_for_timeout(150)
                await bounds(page)
                await cdp.send('Emulation.setPageScaleFactor', {'pageScaleFactor':1})
            await page.set_viewport_size({'width':width,'height':height})
            await page.wait_for_timeout(150)
            await page.get_by_role('button',name='Close assistant').click()
            assert not await page.locator('dialog').is_visible()
            await page.evaluate('window.panel.open()')
            await bounds(page)
            if width==393 and args.screenshot:
                await page.screenshot(path=args.screenshot)
            print(json.dumps({'browser':args.browser,'width':width,'height':height,'result':'passed'}),flush=True)
            await context.close()
        await browser.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',default='http://127.0.0.1:5173')
    parser.add_argument('--browser',choices=['chromium','webkit'],default='chromium')
    parser.add_argument('--screenshot')
    asyncio.run(main(parser.parse_args()))
