"""Run a reviewed local symbolic corpus without mutating its authoritative inputs."""
import argparse
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(catalog_path):
    catalog_path=Path(catalog_path).resolve()
    catalog=json.loads(catalog_path.read_text(encoding='utf-8-sig'))
    if catalog.get('evidence_kind')!='mechanical':
        raise ValueError('This runner produces mechanical evidence only, not model/media acceptance')
    source=(catalog_path.parent/catalog['source_root']).resolve()
    files=catalog['files']
    names=[f['name'] for f in files]
    if len(names)!=len(set(names)):
        raise ValueError('Duplicate corpus file names')
    if catalog['scripts']!=['check_chain.py','reentry.py']:
        raise ValueError('Only the two reviewed project corpus scripts may run')
    for record in files:
        name=record['name']
        if Path(name).name!=name or '/' in name or '\\' in name:
            raise ValueError('Corpus names must be flat file names')
        if sha(source/name)!=record['sha256']:
            raise ValueError('Source version changed; review and explicitly update catalog: '+name)
    if not set(catalog['scripts']).issubset(names):
        raise ValueError('Script is not hash-bound in corpus')
    return catalog_path,catalog,source


def run(catalog_path):
    catalog_hash=sha(Path(catalog_path))
    catalog_path,catalog,source=load(catalog_path)
    fixtures=json.loads((source/'fixtures.json').read_text(encoding='utf-8'))
    chain=json.loads((source/'chain-final.json').read_text(encoding='utf-8'))
    families={c['id'] for c in fixtures['cases']}
    if families!=set(catalog['case_families']):
        raise ValueError('Corpus family selection changed')
    if len(chain['chains'])!=catalog['entry_prompts']:
        raise ValueError('Entry prompt selection changed')
    out_root=catalog_path.parent/'runs'
    scratch=catalog_path.parent/'scratch'
    out_root.mkdir(exist_ok=True);scratch.mkdir(exist_ok=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output=out_root/stamp
    output.mkdir()
    started=time.perf_counter();logs=[]
    with tempfile.TemporaryDirectory(prefix='corpus-',dir=scratch) as temporary:
        work=Path(temporary).resolve()
        if not work.is_relative_to(scratch.resolve()):
            raise ValueError('Temporary workspace escaped corpus scratch directory')
        for record in catalog['files']:
            shutil.copyfile(source/record['name'],work/record['name'])
            if sha(work/record['name'])!=record['sha256']:
                raise ValueError('Source changed while copying')
        for script in catalog['scripts']:
            result=subprocess.run([sys.executable,'-X','utf8','-B',str(work/script)],cwd=work,
                                  capture_output=True,text=True,encoding='utf-8')
            logs.append(dict(script=script,exit_code=result.returncode,stdout=result.stdout,stderr=result.stderr))
            (output/'commands.json').write_text(json.dumps(logs,ensure_ascii=False,indent=2),encoding='utf-8')
            if result.returncode:
                raise RuntimeError('Regression command failed; see '+str(output/'commands.json'))
        checks=json.loads((work/'checks.json').read_text(encoding='utf-8'))
        reentry=json.loads((work/'reentry-result.json').read_text(encoding='utf-8'))
        if not checks['all_passed'] or not reentry['all_passed']:
            raise ValueError('A checker returned unsuccessful results')
        if reentry['independent_model_execution'] or reentry['media_generated']:
            raise ValueError('Evidence level unexpectedly changed')
    # Recheck authority after running; successful commands cannot silently change it.
    load(catalog_path)
    if sha(catalog_path)!=catalog_hash:
        raise ValueError('Catalog changed during execution; rerun against one reviewed version')
    summary=dict(evidence_kind='mechanical',original_case_families=len(families),entry_prompts=len(chain['chains']),
                 original_stage_records=checks['stage_records'],state_controls=checks['negative_control_executions'],
                 text_version_controls=checks['text_review_controls'],resume_controls=reentry['resume_error_controls_rejected'],
                 suffix_unit_visits=reentry['suffix_unit_visits'],mid_unit_resumes=reentry['mid_unit_resume_cases'],
                 independent_model_executions=0,media_acceptance=False,
                 elapsed_seconds=round(time.perf_counter()-started,3),
                 all_mechanical_checks_passed=True,quality_improvement_measured=False,
                 catalog_sha256=catalog_hash)
    (output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    return dict(summary=summary,run_directory=str(output))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog',required=True)
    args=parser.parse_args()
    try:
        print(json.dumps(run(args.catalog),ensure_ascii=False,indent=2))
    except (OSError,ValueError,KeyError,RuntimeError) as error:
        print('Corpus verification failed: '+str(error),file=sys.stderr)
        return 1
    return 0


if __name__=='__main__':
    raise SystemExit(main())
