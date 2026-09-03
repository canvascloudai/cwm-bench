data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${local.name}-ec2-${local.id_slug}"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app_ssm_db" {
  statement {
    sid     = "ReadDbPassword"
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.db_password.arn,
    ]
  }
  statement {
    sid       = "DecryptDbPassword"
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "app_ssm_db" {
  name   = "read-db-password"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.app_ssm_db.json
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name}-profile-${local.id_slug}"
  role = aws_iam_role.ec2.name
}

# IAM is eventually consistent. Wait after the profile API reports success so
# EC2 RunInstances can resolve the profile by name in every region.
resource "time_sleep" "iam_propagation" {
  create_duration = "30s"

  depends_on = [aws_iam_instance_profile.ec2]
}
