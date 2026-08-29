resource "aws_instance" "app" {
  count = var.app_count

  ami                    = local.ami_id
  instance_type          = var.app_instance_type
  subnet_id              = aws_subnet.public[count.index % 2].id
  vpc_security_group_ids = [aws_security_group.app.id]
  iam_instance_profile   = aws_iam_instance_profile.ec2.name
  key_name               = var.key_name != "" ? var.key_name : null

  # 1-minute CPUUtilization. Required for per-node CPU in a campaign run.
  monitoring = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp2"
    volume_size           = var.app_root_volume_gb
    encrypted             = true
    delete_on_termination = true
  }

  user_data_replace_on_change = true
  user_data_base64 = base64gzip(templatefile("${path.module}/userdata/app.sh.tftpl", {
    mysql_host        = aws_db_instance.main.address
    mysql_user        = var.db_username
    mysql_database    = "cwmbench"
    app_pool_size     = var.app_pool_size
    app_queue_limit   = var.app_queue_limit
    db_password_param = aws_ssm_parameter.db_password.name
    region            = var.region
    git_url           = var.app_source_git_url
    git_ref           = var.app_source_git_ref
    test_id           = var.test_id
    server_js_b64     = filebase64("${path.module}/../app/src/server.js")
    package_json_b64  = filebase64("${path.module}/../app/package.json")
    seed_sql_b64      = filebase64("${path.module}/../app/seed/seed.sql")
  }))

  depends_on = [aws_db_instance.main]

  tags = {
    Name = "${local.name}-app-${count.index}"
    Role = "app"
  }
}
