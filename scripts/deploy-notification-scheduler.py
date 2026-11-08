"""Deploy the authorized private notification dispatcher and Supabase cron job.
Credentials stay in Edge secrets and Vault; none are printed or embedded in cron.
"""
import argparse
import hashlib
import hmac
import time
import json
import os
from pathlib import Path
import secrets
import subprocess
import urllib.error
import urllib.request
import uuid

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply',action='store_true')
parser.add_argument('--rotate-key',action='store_true',help='Rotate the private scheduler signing key')
args=parser.parse_args()
if not args.apply:parser.exit(message='No changes made. Pass --apply for an authorized deployment.\n')
root=Path(__file__).resolve().parent.parent
project=os.environ['SUPABASE_URL'].split('//')[1].split('.')[0]
base=f'https://api.supabase.com/v1/projects/{project}'
headers={'Authorization':'Bearer '+(os.environ.get('SUPABASE_ACCESS_KEY') or os.environ['SUPABASE_ACCESS_TOKEN'])}
def request(path,body,content_type='application/json'):
 req=urllib.request.Request(base+path,data=body,headers={**headers,'Content-Type':content_type})
 try:
  with urllib.request.urlopen(req,timeout=90)as response:
   body=response.read()
   return json.loads(body)if body else None
 except urllib.error.HTTPError as error:raise RuntimeError(f'Deployment API {path.split("?")[0]} failed: HTTP {error.code}')from None
def query(sql):return request('/database/query',json.dumps({'query':sql}).encode())
def literal(value):return "'"+value.replace("'","''")+"'"
query("select cron.unschedule(jobid)from cron.job where jobname='pack99-parent-notifications'")if query("select to_regclass('cron.job')present")[0]['present']else None
for filename in ['20261102201000_notification_scheduler.sql','20261102202000_scheduler_queue_privacy.sql','20261102203000_signed_notification_schedule.sql']:
 version,name=Path(filename).stem.split('_',1)
 if not query(f"select version from supabase_migrations.schema_migrations where version='{version}'"):
  body=(root/'supabase/migrations'/filename).read_text()
  query('begin;'+body+f"\ninsert into supabase_migrations.schema_migrations(version,name,statements)values('{version}','{name}',array[$migration${body}$migration$]);commit;")
  print('Applied:',filename)
existing=query("select decrypted_secret from vault.decrypted_secrets where name='pack99_notification_dispatch_secret'")
dispatch_key=existing[0]['decrypted_secret']if existing and not args.rotate_key else secrets.token_hex(32)
secret_values={'PACK99_DATABASE_KEY':os.environ['SUPABASE_SECRET_KEY'],'BREVO_API_KEY':os.environ['BREVO_API_KEY'],'PACK99_FROM_EMAIL':os.environ['PACK99_FROM_EMAIL'],'PACK99_DISPATCH_SECRET':dispatch_key}
request('/secrets',json.dumps([{'name':k,'value':v}for k,v in secret_values.items()]).encode())
print('Configured private Edge secrets')
bundle_path=Path('/tmp/pack99-notification-edge.js')
subprocess.run(['node','--input-type=module','-e',"import{build}from'esbuild';await build({entryPoints:['supabase/functions/parent-notifications/index.ts'],outfile:'/tmp/pack99-notification-edge.js',bundle:true,format:'esm',platform:'neutral',target:'es2022'});"],cwd=root,check=True)
boundary='pack99-'+uuid.uuid4().hex
metadata=json.dumps({'name':'parent-notifications','entrypoint_path':'index.ts','verify_jwt':False}).encode()
parts=[]
for field,body,filename,mime in [('metadata',metadata,None,'application/json'),('file',bundle_path.read_bytes(),'index.ts','application/typescript')]:
 disposition=f'form-data; name="{field}"'+(f'; filename="{filename}"'if filename else '')
 parts.append(f'--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {mime}\r\n\r\n'.encode()+body+b'\r\n')
result=request('/functions/deploy?slug=parent-notifications',b''.join(parts)+f'--{boundary}--\r\n'.encode(),'multipart/form-data; boundary='+boundary)
print('Dispatcher deployment:',json.dumps({k:result.get(k)for k in ['slug','version','status','verify_jwt']}))
endpoint=os.environ['SUPABASE_URL']+'/functions/v1/parent-notifications'
# Never call the authenticated dispatcher as a deployment check: it sends parent emails.
sql='begin;'
if existing and args.rotate_key:sql+=f"select vault.update_secret((select id from vault.secrets where name='pack99_notification_dispatch_secret'),{literal(dispatch_key)});"
if not existing:sql+=f"select vault.create_secret({literal(dispatch_key)},'pack99_notification_dispatch_secret');"
sql+=f"insert into private.pack_notification_settings values(true,{literal(endpoint)})on conflict(singleton)do update set endpoint=excluded.endpoint;"
sql+="select cron.schedule('pack99-parent-notifications','*/5 * * * *','select private.invoke_parent_notification_dispatch();');commit;"
query(sql)
print('Enabled notification scheduler: every five minutes; reminders gated to Saturday 8am Pacific')
