# DELETE the whole test environment: server, database (no final snapshot),
# secrets, deploy bucket, schedules, IAM roles, network rules.
# The billing budget is kept — it is free and still useful.
#
# Irreversible. Export anything you want to keep first.
$aws      = 'C:\Program Files\Amazon\AWSCLIV2\aws.exe'
$r        = 'ap-south-1'
$instance = 'i-0f31e28ef78199ee1'
$bucket   = 'crm-test-deploy-010539085833'

$answer = Read-Host "This deletes the CRM test server AND database permanently. Type 'delete crm-test' to continue"
if ($answer -ne 'delete crm-test') { 'Cancelled.'; exit 1 }

'== schedules'
foreach ($n in 'ec2', 'rds') { & $aws scheduler delete-schedule --region $r --name "crm-test-nightly-stop-$n" }

'== server'
& $aws ec2 terminate-instances --region $r --instance-ids $instance | Out-Null

'== database'
& $aws rds modify-db-instance --region $r --db-instance-identifier crm-test-db --no-deletion-protection --apply-immediately | Out-Null
& $aws rds delete-db-instance --region $r --db-instance-identifier crm-test-db --skip-final-snapshot --delete-automated-backups | Out-Null

'== secrets'
$names = & $aws ssm get-parameters-by-path --region $r --path /crm/test --query 'Parameters[].Name' --output text
if ($names) { & $aws ssm delete-parameters --region $r --names ($names -split '\s+') | Out-Null }

'== bucket'
& $aws s3 rm "s3://$bucket" --recursive --region $r --only-show-errors
& $aws s3api delete-bucket --region $r --bucket $bucket

'== iam'
& $aws iam remove-role-from-instance-profile --instance-profile-name crm-test-ec2 --role-name crm-test-ec2
& $aws iam delete-instance-profile --instance-profile-name crm-test-ec2
& $aws iam detach-role-policy --role-name crm-test-ec2 --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
& $aws iam delete-role-policy --role-name crm-test-ec2 --policy-name crm-test-app
& $aws iam delete-role --role-name crm-test-ec2
& $aws iam delete-role-policy --role-name crm-test-scheduler --policy-name crm-test-stop
& $aws iam delete-role --role-name crm-test-scheduler

'== waiting for server and database to finish deleting (up to ~15 min)'
& $aws ec2 wait instance-terminated --region $r --instance-ids $instance
& $aws rds wait db-instance-deleted --region $r --db-instance-identifier crm-test-db

'== network'
& $aws rds delete-db-subnet-group --region $r --db-subnet-group-name crm-test
foreach ($g in 'crm-test-db', 'crm-test-web') {
  $id = & $aws ec2 describe-security-groups --region $r --filters "Name=group-name,Values=$g" --query 'SecurityGroups[0].GroupId' --output text
  if ($id -and $id -ne 'None') { & $aws ec2 delete-security-group --region $r --group-id $id }
}
'Done.'
